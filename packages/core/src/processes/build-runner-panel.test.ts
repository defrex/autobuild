import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, KERNEL, humanActor } from '../events/envelope'
import { sequentialIds } from '../ids'
import type { Decision } from '../kernel/engine'
import type { PanelMetric } from '../objective'
import { FakeForge } from '../ports/forge/fake'
import {
  ScriptedAgentRunner,
  defaultTurnResult,
  failedTurnResult,
  type ScriptContext,
} from '../ports/runner/fake'
import type { AgentTurnResult } from '../ports/types'
import type { Exec, ExecResult } from '../ports/workspace/git-worktree'
import { panelObjective } from '../kernel/generators/optimization-log'
import { reduceBuild } from '../kernel/reducer'
import type { Objective } from '../objective'
import { MemoryBuildStore } from '../store/memory'
import { scopeLocalStoreToJudgeSession } from '../store/phase-session'
import type { StreamOutcome } from '../store/streams/types'
import type { BuildScopedStore, BuildStore } from '../store/types'
import { steppingClock } from '../testing/fixed'
import { BuildRunner, type BuildRunnerDeps, type PanelRequest } from './build-runner'

const LAUNCHER = '#!/usr/bin/env bun\nconsole.log("judge")\n'
import {
  EXECUTABLE_PROBE,
  JUDGE_PREFERENCE_OUTBOX,
  PHYSICAL_PATHS_PROBE,
  REAL_ENTRY_PROBE,
  TMPDIR_PROBE,
} from './panel-runner'

const SLUG = 'attempt-a1'
const WORKSPACE = '/ws/attempt-a1'
const CANDIDATE = 'c'.repeat(40)
const BASELINE = 'b'.repeat(40)
const PIN = 'a'.repeat(40)

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 })

/** Files under judge roots, shared by the scripted judges and the fake shell. */
type Files = Map<string, string>

/** Outbox content the fake shell finds present but fails to read. */
const UNREADABLE = '\0unreadable'

/** Git and shell plumbing for the materializer, answering every probe, with
 * judge roots' files held in `files` so outboxes round-trip. */
function fakeExec(
  files: Files,
  alive: () => boolean = () => true,
  protectedExecutables: readonly string[] = [],
): Exec {
  return async (cmd) => {
    // A dead process runs nothing, so it cleans nothing up either.
    if (!alive()) throw new Error('process crashed')
    if (cmd[0] === 'sh' && cmd[2] === TMPDIR_PROBE) return ok('/tmp/t\n')
    if (cmd[0] === 'sh' && cmd[2] === 'cd "$1" && pwd -P') return ok(`${cmd[4]}\n`)
    if (cmd[0] === 'sh' && cmd[2] === REAL_ENTRY_PROBE) return ok(`${cmd[4]}\n`)
    if (cmd[0] === 'sh' && cmd[2] === PHYSICAL_PATHS_PROBE)
      return ok(
        cmd
          .slice(4)
          .map((path) => `${path}\n`)
          .join(''),
      )
    if (cmd[0] === 'sh' && cmd[2] === EXECUTABLE_PROBE)
      return ok(
        protectedExecutables.includes(cmd[5]!)
          ? `${WORKSPACE}/bin/${cmd[5]}\n`
          : `/usr/bin/${cmd[5]}\n`,
      )
    if (cmd[0] === 'sh' && cmd[3] === 'judge-outbox') {
      const content = files.get(cmd[4]!)
      if (content === UNREADABLE) return { stdout: '1', stderr: 'head: read error', exitCode: 1 }
      return ok(content === undefined ? '0' : `1${content}`)
    }
    if (cmd[0] === 'rm')
      for (const path of cmd.slice(2))
        for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key)
    if (cmd.includes('--show-toplevel')) return ok(`${WORKSPACE}\n/ws/.git\n`)
    if (cmd.includes('--git-common-dir')) return ok('/ws/.git\n')
    if (cmd.includes('--git-dir'))
      return { stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }
    if (cmd.includes('ls-tree')) return ok('')
    if (cmd.includes('cat-file') && cmd[2] === 'blob') return ok('pinned skill\n')
    return ok()
  }
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

/** The scripted judge saves its preference the way `ab judge prefer` does for
 * a local store: once, to the outbox in its root, which the runner commits. */
function judgeRunner(
  files: Files,
  script: JudgeScript,
  Runner: typeof ScriptedAgentRunner = ScriptedAgentRunner,
): ScriptedAgentRunner {
  return new Runner({
    script: (ctx) => {
      const [, panel, judge] = ctx.opts.env.AB_JUDGE!.split(':')
      const session = ctx.opts.env.AB_SESSION!
      const outbox = `${ctx.opts.workspacePath}/${JUDGE_PREFERENCE_OUTBOX}`
      return script(ctx, async (preference) => {
        if (files.has(outbox)) throw new Error('EEXIST')
        files.set(
          outbox,
          JSON.stringify({
            panel,
            judge: Number(judge),
            session,
            preference,
            reason: `prefers ${preference}`,
          }),
        )
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
    files?: Files
    alive?: () => boolean
    random?: () => number
    shutdownSignal?: AbortSignal
    ids?: () => string
    sessionEnv?: Record<string, string>
    delegateCredential?: BuildRunnerDeps['delegateCredential']
    slug?: string
    /** Extra configuration, e.g. a `[roles.judge]` table with alternates. */
    roles?: string
    runtimes?: BuildRunnerDeps['runtimes']
    protectedExecutables?: readonly string[]
    wrapStore?: (store: BuildScopedStore) => BuildScopedStore
    timeoutSignal?: BuildRunnerDeps['timeoutSignal']
  } = {},
) {
  const slug = opts.slug ?? SLUG
  const config = parseConfig(
    '[tickets]\nsource = "file"\nreadyState = "ready"\n\n[roles.default]\nruntime = "scripted"\n' +
      (opts.roles ?? ''),
  )
  const ids = sequentialIds()
  return new BuildRunner({
    store: (opts.wrapStore ?? ((scoped) => scoped))((store as MemoryBuildStore).scopeBuild(slug)),
    config,
    runtimes: { scripted: { runner: agent, servesModels: [''] }, ...opts.runtimes },
    workspacePath: WORKSPACE,
    branch: `ab/${slug}`,
    slug,
    exec: fakeExec(opts.files ?? new Map(), opts.alive, opts.protectedExecutables),
    timeoutSignal: opts.timeoutSignal ?? (() => new AbortController().signal),
    random: opts.random ?? (() => 0.25),
    judgeSkill: async () => 'distribution skill\n',
    judgeLauncher: async () => LAUNCHER,
    ...(opts.delegateCredential !== undefined
      ? { delegateCredential: opts.delegateCredential }
      : {}),
    ...(opts.shutdownSignal !== undefined ? { shutdownSignal: opts.shutdownSignal } : {}),
    forge: new FakeForge(),
    ids: (prefix) => (prefix === 's' && opts.ids ? opts.ids() : ids(prefix)),
    clock: steppingClock(),
    instance: 'runner-1',
    host: 'test',
    sessionEnv: opts.sessionEnv ?? {
      AB_STORE: '/store/local',
      AB_TOKEN: 'runner-token',
      AB_BUILD: slug,
    },
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
    const files: Files = new Map()
    let started = 0
    let release!: () => void
    const allStarted = new Promise<void>((resolve) => {
      release = resolve
    })
    const preferences: Array<'A' | 'B' | 'tie'> = ['A', 'B', 'tie']
    const seen: Array<{ env: Record<string, string>; workspace: string; order?: string }> = []
    const agent = judgeRunner(files, async (ctx, prefer) => {
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
    const runner = runnerFor(store, agent, { files, random: () => random.shift()! })
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
    const files: Files = new Map()
    let effective: Record<string, string> = {}
    const agent = judgeRunner(files, async (ctx, prefer) => {
      effective = ctx.opts.env
      await prefer('A')
      return defaultTurnResult()
    })
    await runnerFor(store, agent, { files }).runPanel({ ...REQUEST, judges: 1 })
    const journal = [...agent.sessions.values()][0]!
    const raw = journal.opts.env
    expect(raw.AB_JUDGE).toBe(`${SLUG}:panel-1:1`)
    expect(raw.AB_CONTEXT_DIR).toBe('.ab/judge')
    expect(raw.AB_SESSION).toBeDefined()
    // A local judge learns no store path and holds no credential.
    for (const key of ['AB_STORE', 'AB_BUILD', 'AB_PHASE', 'AB_TOKEN'])
      expect(key in raw).toBe(false)
    // Its launch hides the workspace, its common directory, the main checkout
    // and the store, and puts the scratch launcher first.
    expect(journal.opts.judgeLaunch?.hide).toEqual([WORKSPACE, '/ws/.git', '/ws', '/store/local'])
    expect(journal.opts.judgeLaunch?.binDir).toMatch(/^\/tmp\/t\/autobuild-judge-bin-[0-9a-f]{16}$/)
    expect(effective.PATH!.split(':')[0]).toBe(journal.opts.judgeLaunch!.binDir)
    expect(journal.opts.invocation).toBe('panel-1')
    expect(journal.opts.skill).toBe('ab-judge')
    expect(journal.opts.workspacePath).toMatch(/^\/tmp\/t\/autobuild-judge-[0-9a-f]{16}$/)
    const { judgeLaunch: _hidden, ...opts } = journal.opts
    const launched = JSON.stringify(opts)
    for (const forbidden of [WORKSPACE, CANDIDATE, BASELINE, PIN, 'candidate', 'baseline'])
      expect(launched).not.toContain(forbidden)
  })

  test('a judge without a preference is retried once, then the run fails', async () => {
    const store = await seeded()
    const files: Files = new Map()
    const agent = judgeRunner(files, async (ctx, prefer) => {
      if (ctx.opts.env.AB_JUDGE!.endsWith(':2')) return defaultTurnResult()
      await prefer('A')
      return defaultTurnResult()
    })
    const result = await runnerFor(store, agent, { files }).runPanel({ ...REQUEST, judges: 2 })
    expect(result).toEqual({
      kind: 'failed',
      reason: 'judge 2 failed 2 times; last outcome no-terminal',
    })
    expect(agent.sessions.size).toBe(3)
  })

  test('a resumed run completes a saved preference without a session and reruns the rest', async () => {
    const store = await seeded()
    const files: Files = new Map()
    // The first run crashes right after judge 3 saves its preference to its
    // outbox: every later write and shell command by that runner fails, as a
    // dead process does nothing, so the saved outbox survives in its root.
    let crashed = false
    let endedCount = 0
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
                  const written = out as { type?: string; event?: { type?: string } } | null
                  if ((written?.event?.type ?? written?.type) === 'panel.judge-ended') {
                    endedCount += 1
                    if (endedCount === 2) twoJudged()
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
    const first = judgeRunner(files, async (ctx, prefer) => {
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
    const crashedRun = runnerFor(crashing as unknown as BuildStore, first, {
      files,
      alive: () => !crashed,
    }).runPanel({
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
    const second = judgeRunner(files, async (ctx, prefer) => {
      expect(ctx.opts.env.AB_JUDGE).toBe(`${SLUG}:panel-1:4`)
      await prefer('tie')
      return defaultTurnResult()
    })
    const result = await runnerFor(store, second, {
      files,
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
    const files: Files = new Map()
    const agent = judgeRunner(files, async (_ctx, prefer) => {
      await prefer('A')
      return defaultTurnResult()
    })
    await runnerFor(store, agent, { files }).runPanel({ ...REQUEST, judges: 1 })
    await expect(
      runnerFor(store, agent, { files }).runPanel({ ...REQUEST, judges: 1, purpose: 'other' }),
    ).rejects.toThrow('different inputs')
  })

  test('shutdown during a turn records interrupted and returns interrupted', async () => {
    const store = await seeded()
    const files: Files = new Map()
    const controller = new AbortController()
    const agent = judgeRunner(files, async () => {
      controller.abort()
      return defaultTurnResult()
    })
    const result = await runnerFor(store, agent, {
      files,
      shutdownSignal: controller.signal,
    }).runPanel({
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

describe('a panel attempt measurement', () => {
  const metric: PanelMetric = {
    kind: 'panel',
    judges: 2,
    rubric: 'evals/rubric.md',
    harness: ['evals/**'],
  }

  async function request(
    store: MemoryBuildStore,
    id = 'm1',
    purpose: string | undefined = REQUEST.purpose,
  ) {
    await store.append(SLUG, {
      actor: DISPATCHER,
      type: 'attempt.measurement-requested',
      payload: {
        id,
        node: 'node',
        candidate: CANDIDATE,
        baseline: BASELINE,
        harnessPin: PIN,
        revision: 1,
        metric,
        ...(purpose !== undefined ? { purpose } : {}),
      },
    })
    const state = reduceBuild(await store.getEvents(SLUG))
    const { seq: _seq, ...payload } = state.attemptMeasurement!.request!
    return payload
  }

  const measure = (runner: BuildRunner, payload: Awaited<ReturnType<typeof request>>) =>
    (
      runner as unknown as {
        runMeasurement(decision: Extract<Decision, { kind: 'run-measurement' }>): Promise<void>
      }
    ).runMeasurement({ kind: 'run-measurement', request: payload })

  const last = async (store: MemoryBuildStore) => (await store.getEvents(SLUG)).at(-1)!

  test('judges the attempt head against the node head and records the win rate', async () => {
    const store = await seeded()
    const files: Files = new Map()
    const agent = judgeRunner(files, async (_ctx, prefer) => {
      await prefer('A')
      return defaultTurnResult()
    })
    // Both judges see the candidate first: A is the candidate, so it wins both.
    await measure(runnerFor(store, agent, { files, random: () => 0.1 }), await request(store))
    const events = await store.getEvents(SLUG)
    const started = events.find((event) => event.type === 'panel.started')!
    expect(started.payload).toMatchObject({
      panel: 'attempt-m1',
      candidate: CANDIDATE,
      baseline: BASELINE,
      harnessPin: PIN,
      purpose: REQUEST.purpose,
      rubric: metric.rubric,
      judges: 2,
    })
    const sampled = events.at(-1) as AbEvent & { type: 'attempt.sampled' }
    expect(sampled.type).toBe('attempt.sampled')
    expect(sampled.payload).toEqual({
      request: 'm1',
      candidate: CANDIDATE,
      baseline: BASELINE,
      harnessPin: PIN,
      revision: 1,
      samples: 2,
      winRate: 1,
      report: { kind: 'measurement-samples', rev: 0 },
    })
    expect(events.map((event) => event.type)).not.toContain('attempt.measured')
    const report = await store.getArtifact(SLUG, 'measurement-samples', 0)
    const judged = JSON.parse(new TextDecoder().decode(report!.content))
    expect(judged).toMatchObject({ kind: 'panel', panel: 'attempt-m1', winRate: 1 })
    expect(judged.judgments).toHaveLength(2)
  })

  test('a failed panel escalates; the answer judges afresh under a new panel id', async () => {
    const store = await seeded()
    const files: Files = new Map()
    let fail = true
    const agent = judgeRunner(files, async (ctx, prefer) => {
      if (fail && ctx.opts.env.AB_JUDGE!.endsWith(':2')) return defaultTurnResult()
      await prefer('B')
      return defaultTurnResult()
    })
    const payload = await request(store)
    await measure(runnerFor(store, agent, { files }), payload)
    const raised = (await last(store)) as AbEvent & { type: 'escalation.raised' }
    expect(raised.type).toBe('escalation.raised')
    expect(raised.payload).toMatchObject({
      phase: 'measurement',
      policyCause: 'measurement-failed',
      question: expect.stringContaining('Judge panel attempt-m1 for measurement request m1 failed'),
    })
    expect((await store.getEvents(SLUG)).map((event) => event.type)).not.toContain(
      'attempt.sampled',
    )
    await store.append(SLUG, {
      actor: humanActor('ada'),
      type: 'escalation.answered',
      payload: { id: raised.payload.id, answer: 'judge again', resolution: 'guidance' },
    })
    const answered = (await last(store)).seq
    fail = false
    let session = 0
    await measure(runnerFor(store, agent, { files, ids: () => `s_retry_${++session}` }), payload)
    const events = await store.getEvents(SLUG)
    const panels = events
      .filter((event) => event.type === 'panel.started')
      .map((event) => (event.payload as { panel: string }).panel)
    expect(panels).toEqual(['attempt-m1', `attempt-m1-a${answered}`])
    expect(events.at(-1)!.payload).toMatchObject({ winRate: 0 })
  })

  test('an interrupted panel records no samples and resumes under the same id', async () => {
    const store = await seeded()
    const files: Files = new Map()
    const controller = new AbortController()
    const interrupting = judgeRunner(files, async () => {
      controller.abort()
      return defaultTurnResult()
    })
    const payload = await request(store)
    await measure(
      runnerFor(store, interrupting, { files, shutdownSignal: controller.signal }),
      payload,
    )
    expect((await store.getEvents(SLUG)).map((event) => event.type)).not.toContain(
      'attempt.sampled',
    )
    const judging = judgeRunner(files, async (_ctx, prefer) => {
      await prefer('tie')
      return defaultTurnResult()
    })
    await measure(runnerFor(store, judging, { files }), payload)
    const events = await store.getEvents(SLUG)
    expect(
      events.filter((event) => event.type === 'panel.started').map((event) => event.payload),
    ).toEqual([expect.objectContaining({ panel: 'attempt-m1' })])
    expect(events.at(-1)!.payload).toMatchObject({ winRate: 0.5 })
  })

  test('a newer request supersedes the panel result', async () => {
    const store = await seeded()
    const files: Files = new Map()
    let superseded = false
    const agent = judgeRunner(files, async (_ctx, prefer) => {
      if (!superseded) {
        superseded = true
        await request(store, 'm2')
      }
      await prefer('A')
      return defaultTurnResult()
    })
    await measure(runnerFor(store, agent, { files }), await request(store))
    const types = (await store.getEvents(SLUG)).map((event) => event.type)
    expect(types).not.toContain('attempt.sampled')
    expect(types).not.toContain('escalation.raised')
  })

  test('a panel request without the purpose escalates without judging', async () => {
    const store = await seeded()
    const files: Files = new Map()
    const agent = judgeRunner(files, async () => defaultTurnResult())
    // An unvalidated reader could hand the runner such a request.
    const payload = await request(store)
    const { purpose: _purpose, ...unpurposed } = payload
    await measure(runnerFor(store, agent, { files }), unpurposed)
    expect(agent.sessions.size).toBe(0)
    expect((await last(store)).payload).toMatchObject({
      phase: 'measurement',
      question: expect.stringContaining('without the objective purpose'),
    })
  })
})

describe('BuildRunner judge credentials and outbox', () => {
  test('a remote judge gets the store URL and only its delegated judge token', async () => {
    const store = await seeded()
    const issued: Array<{ store: string; parent: string | undefined; target: unknown }> = []
    let effective: Record<string, string> = {}
    const agent = new ScriptedAgentRunner({
      script: (ctx) => {
        effective = ctx.opts.env
        return defaultTurnResult()
      },
    })
    await runnerFor(store, agent, {
      sessionEnv: { AB_STORE: 'https://store.example', AB_TOKEN: 'runner-token', AB_BUILD: SLUG },
      delegateCredential: async (url, parent, target) => {
        issued.push({ store: url, parent, target })
        return 'judge-token'
      },
    }).runPanel({ ...REQUEST, judges: 1 })
    const raw = [...agent.sessions.values()][0]!.opts.env
    expect(raw.AB_STORE).toBe('https://store.example')
    expect(raw.AB_TOKEN).toBe('judge-token')
    expect(effective.AB_TOKEN).toBe('judge-token')
    expect(JSON.stringify(raw)).not.toContain('runner-token')
    expect(issued[0]).toMatchObject({
      store: 'https://store.example',
      parent: 'runner-token',
      target: { kind: 'build-judge', id: SLUG, panel: 'panel-1', judge: 1 },
    })
    // The remote store is not a protected path; nothing local is hidden but
    // the repository.
    expect([...agent.sessions.values()][0]!.opts.judgeLaunch?.hide).toEqual([
      WORKSPACE,
      '/ws/.git',
      '/ws',
    ])
  })

  test('a delegation failure fails the judge without starting a session', async () => {
    const store = await seeded()
    const agent = new ScriptedAgentRunner({ script: () => defaultTurnResult() })
    const result = await runnerFor(store, agent, {
      sessionEnv: { AB_STORE: 'https://store.example', AB_TOKEN: 'runner-token' },
      delegateCredential: async () => {
        throw new Error('issuance refused')
      },
    }).runPanel({ ...REQUEST, judges: 1 })
    expect(agent.sessions.size).toBe(0)
    expect(result).toEqual({
      kind: 'failed',
      reason: 'judge 1 failed 2 times; last outcome failed',
    })
    const ended = panelEvents(await store.getEvents(SLUG)).filter(
      (event) => event.type === 'panel.judge-ended',
    )
    expect(ended.map((event) => event.payload)).toEqual([
      expect.objectContaining({ outcome: 'failed', error: 'issuance refused' }),
      expect.objectContaining({ outcome: 'failed', error: 'issuance refused' }),
    ])
  })

  test('an outbox that is malformed or names another session records why, and no preference', async () => {
    for (const [content, error] of [
      ['{not json', 'the saved judge preference is malformed'],
      [
        (session: string) =>
          JSON.stringify({
            panel: 'panel-1',
            judge: 1,
            session: `${session}-other`,
            preference: 'A',
            reason: 'r',
          }),
        'the saved judge preference was refused: preference for another session',
      ],
      [
        (session: string) =>
          JSON.stringify({ panel: 'panel-1', judge: 1, session, preference: 'A', reason: ' ' }),
        'the saved judge preference is malformed',
      ],
    ] as const) {
      const store = await seeded()
      const files: Files = new Map()
      const agent = new ScriptedAgentRunner({
        script: (ctx) => {
          const text = typeof content === 'string' ? content : content(ctx.opts.env.AB_SESSION!)
          files.set(`${ctx.opts.workspacePath}/${JUDGE_PREFERENCE_OUTBOX}`, text)
          return defaultTurnResult()
        },
      })
      await runnerFor(store, agent, { files }).runPanel({ ...REQUEST, judges: 1 })
      const events = panelEvents(await store.getEvents(SLUG))
      expect(events.some((event) => event.type === 'panel.preferred')).toBe(false)
      const ended = events.find((event) => event.type === 'panel.judge-ended')!
      expect(ended.payload).toMatchObject({ outcome: 'no-terminal', error })
    }
  })

  test('an outbox for a session that already preferred is success, recorded once', async () => {
    const store = await seeded()
    const files: Files = new Map()
    const agent = judgeRunner(files, async (ctx, prefer) => {
      const session = ctx.opts.env.AB_SESSION!
      // The same preference reached the store another way first.
      await scopeLocalStoreToJudgeSession(store, {
        build: SLUG,
        panel: 'panel-1',
        judge: 1,
        session,
      }).append(SLUG, {
        actor: { kind: 'agent', role: 'judge', session },
        type: 'panel.preferred',
        payload: { panel: 'panel-1', judge: 1, session, preference: 'A', reason: 'r' },
      })
      await prefer('A')
      return defaultTurnResult()
    })
    const result = await runnerFor(store, agent, { files }).runPanel({ ...REQUEST, judges: 1 })
    expect(result.kind).toBe('judged')
    const events = panelEvents(await store.getEvents(SLUG))
    expect(events.filter((event) => event.type === 'panel.preferred')).toHaveLength(1)
    expect(events.find((event) => event.type === 'panel.judge-ended')!.payload).toMatchObject({
      outcome: 'completed',
    })
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

  const nodeFiles = new WeakMap<ScriptedAgentRunner, Files>()

  // Every runner draws session ids from one sequence, as distinct processes do.
  let sessions = 0
  const nodeRunner = (
    store: MemoryBuildStore,
    agent: ScriptedAgentRunner,
    opts: { shutdownSignal?: AbortSignal } = {},
  ) =>
    runnerFor(store, agent, {
      ...opts,
      files: nodeFiles.get(agent),
      slug: NODE,
      ids: () => `s_node_${++sessions}`,
    })

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

  const localJudges = (script: JudgeScript): ScriptedAgentRunner => {
    const files: Files = new Map()
    const agent = judgeRunner(files, script)
    nodeFiles.set(agent, files)
    return agent
  }

  /** Judges preferring `choices[judge - 1]`; every order is candidate-first. */
  const judging = (_store: MemoryBuildStore, choices: Array<'A' | 'B' | 'tie' | 'none'>) =>
    localJudges(async (ctx, prefer) => {
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
    const agent = localJudges(async (_ctx, prefer) => {
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
    const interrupting = localJudges(async (ctx, prefer) => {
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

/** A second runtime that spawns its own executable by name. */
class BackupRunner extends ScriptedAgentRunner {
  readonly executable = 'backup-cli'
}

const JUDGE_ALTERNATE =
  '\n[roles.judge]\nruntime = "scripted"\nalternates = [{ runtime = "backup" }]\n'

const unavailable = () => failedTurnResult('provider overloaded', false, '', 'availability')

describe('BuildRunner judge provider alternates', () => {
  const backupFor = (files: Files, script: JudgeScript) => {
    const runner = judgeRunner(files, script, BackupRunner)
    return { runner, sessions: runner.sessions }
  }

  test('a working primary never starts the alternate', async () => {
    const store = await seeded()
    const files: Files = new Map()
    const agent = judgeRunner(files, async (_ctx, prefer) => {
      await prefer('A')
      return defaultTurnResult()
    })
    const backup = backupFor(files, () => defaultTurnResult())
    const result = await runnerFor(store, agent, {
      files,
      roles: JUDGE_ALTERNATE,
      runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
    }).runPanel({ ...REQUEST, judges: 2 })
    expect(result.kind).toBe('judged')
    expect(agent.sessions.size).toBe(2)
    expect(backup.sessions.size).toBe(0)
  })

  test('an eligible failure falls back to the alternate in the same root and order', async () => {
    const store = await seeded()
    const files: Files = new Map()
    const agent = judgeRunner(files, () => unavailable())
    const backup = backupFor(files, async (_ctx, prefer) => {
      await prefer('B')
      return defaultTurnResult()
    })
    const result = await runnerFor(store, agent, {
      files,
      roles: JUDGE_ALTERNATE,
      runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
    }).runPanel({ ...REQUEST, judges: 1 })
    expect(result.kind).toBe('judged')
    const events = panelEvents(await store.getEvents(SLUG))
    const starts = events.filter((event) => event.type === 'panel.judge-started')
    expect(starts).toHaveLength(2)
    const [first, second] = starts.map((event) => event.payload)
    expect(first).toMatchObject({ judge: 1, runner: 'scripted' })
    expect(first!.substitution).toBeUndefined()
    expect(second).toMatchObject({
      judge: 1,
      runner: 'backup',
      order: first!.order,
      substitution: {
        failed: {
          index: 0,
          session: first!.session,
          runner: 'scripted',
          error: 'provider overloaded',
          cause: 'availability',
        },
        selectedIndex: 1,
      },
    })
    // The failed session ends before the alternate starts.
    const firstEnd = events.find(
      (event) => event.type === 'panel.judge-ended' && event.payload.session === first!.session,
    )!
    expect(firstEnd.payload).toMatchObject({ outcome: 'failed', error: 'provider overloaded' })
    expect(firstEnd.seq).toBeLessThan(starts[1]!.seq)
    const secondEnd = events.find(
      (event) => event.type === 'panel.judge-ended' && event.payload.session === second!.session,
    )!
    expect(secondEnd.payload).toMatchObject({ outcome: 'completed' })
    expect(events.filter((event) => event.type === 'panel.preferred')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'panel.judged')).toHaveLength(1)
    // Each target is its own session, with its own identity, in one root,
    // and both receive the same launch context.
    const primary = [...agent.sessions.values()][0]!.opts
    const alternate = [...backup.sessions.values()][0]!.opts
    expect(alternate.env.AB_SESSION).toBe(second!.session)
    expect(primary.env.AB_SESSION).toBe(first!.session)
    expect(alternate.env.AB_JUDGE).toBe(primary.env.AB_JUDGE)
    expect(alternate.workspacePath).toBe(primary.workspacePath)
    expect(alternate.judgeLaunch).toBe(primary.judgeLaunch)
    // Transcripts name the runtime that ran each session.
    const transcripts = await store.listArtifacts(SLUG, 'transcript')
    expect(transcripts.map((meta) => meta.metadata.runner)).toEqual(['scripted', 'backup'])
  })

  test('only the last failure of an exhausted chain counts toward the judge', async () => {
    const store = await seeded()
    const agent = new ScriptedAgentRunner({ script: () => unavailable() })
    const backup = backupFor(new Map(), () => unavailable())
    const result = await runnerFor(store, agent, {
      roles: JUDGE_ALTERNATE,
      runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
    }).runPanel({ ...REQUEST, judges: 1 })
    expect(result).toEqual({
      kind: 'failed',
      reason: 'judge 1 failed 2 times; last outcome failed',
    })
    expect(agent.sessions.size).toBe(2)
    expect(backup.sessions.size).toBe(2)
  })

  test('an ineligible failure or a delegation failure starts no alternate', async () => {
    for (const variant of ['credentials', 'delegation'] as const) {
      const store = await seeded()
      const agent = new ScriptedAgentRunner({
        script: () => failedTurnResult('bad key', true, '', 'credentials'),
      })
      const backup = backupFor(new Map(), () => defaultTurnResult())
      const result = await runnerFor(store, agent, {
        roles: JUDGE_ALTERNATE,
        runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
        ...(variant === 'delegation'
          ? {
              sessionEnv: { AB_STORE: 'https://store.example', AB_TOKEN: 'runner-token' },
              delegateCredential: async () => {
                throw new Error('issuance refused')
              },
            }
          : {}),
      }).runPanel({ ...REQUEST, judges: 1 })
      expect(result.kind).toBe('failed')
      expect(backup.sessions.size).toBe(0)
      const starts = panelEvents(await store.getEvents(SLUG)).filter(
        (event) => event.type === 'panel.judge-started',
      )
      expect(starts.map((event) => event.payload.runner)).toEqual(['scripted', 'scripted'])
    }
  })

  test('an expired session budget starts no alternate', async () => {
    const store = await seeded()
    const agent = new ScriptedAgentRunner({ script: () => unavailable() })
    const backup = backupFor(new Map(), () => defaultTurnResult())
    const result = await runnerFor(store, agent, {
      roles: JUDGE_ALTERNATE,
      runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
      timeoutSignal: () => AbortSignal.abort(),
    }).runPanel({ ...REQUEST, judges: 1 })
    expect(result).toMatchObject({ kind: 'failed' })
    expect(backup.sessions.size).toBe(0)
  })

  test('a saved preference or outbox is settled first and ends the chain', async () => {
    // A preference saved before a failure wins over the failure.
    {
      const store = await seeded()
      const files: Files = new Map()
      const agent = judgeRunner(files, async (_ctx, prefer) => {
        await prefer('A')
        return unavailable()
      })
      const backup = backupFor(files, () => defaultTurnResult())
      const result = await runnerFor(store, agent, {
        files,
        roles: JUDGE_ALTERNATE,
        runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
      }).runPanel({ ...REQUEST, judges: 1 })
      expect(result.kind).toBe('judged')
      expect(backup.sessions.size).toBe(0)
    }
    // A present but unusable outbox is a terminal attempt: no alternate
    // starts in a root that still holds it.
    {
      const store = await seeded()
      const files: Files = new Map()
      const agent = new ScriptedAgentRunner({
        script: (ctx) => {
          files.set(`${ctx.opts.workspacePath}/${JUDGE_PREFERENCE_OUTBOX}`, '{not json')
          return unavailable()
        },
      })
      const backup = backupFor(files, () => defaultTurnResult())
      await runnerFor(store, agent, {
        files,
        roles: JUDGE_ALTERNATE,
        runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
      }).runPanel({ ...REQUEST, judges: 1 })
      expect(backup.sessions.size).toBe(0)
    }
    // An outbox that exists but cannot be read may hold a saved preference:
    // the failure counts with the read error and no alternate starts.
    {
      const store = await seeded()
      const files: Files = new Map()
      const agent = new ScriptedAgentRunner({
        script: (ctx) => {
          files.set(`${ctx.opts.workspacePath}/${JUDGE_PREFERENCE_OUTBOX}`, UNREADABLE)
          return unavailable()
        },
      })
      const backup = backupFor(files, () => defaultTurnResult())
      await runnerFor(store, agent, {
        files,
        roles: JUDGE_ALTERNATE,
        runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
      }).runPanel({ ...REQUEST, judges: 1 })
      expect(backup.sessions.size).toBe(0)
      const events = panelEvents(await store.getEvents(SLUG))
      const started = events.filter((event) => event.type === 'panel.judge-started')
      expect(started.some((event) => 'substitution' in event.payload)).toBe(false)
      for (const event of events.filter((event) => event.type === 'panel.judge-ended'))
        expect(event.payload).toMatchObject({ outcome: 'failed' })
    }
    // A remote judge that recorded its preference through the store, then
    // failed, starts no alternate either.
    {
      const store = await seeded()
      const agent = new ScriptedAgentRunner({
        script: async (ctx) => {
          const session = ctx.opts.env.AB_SESSION!
          await scopeLocalStoreToJudgeSession(store, {
            build: SLUG,
            panel: 'panel-1',
            judge: 1,
            session,
          }).append(SLUG, {
            actor: { kind: 'agent', role: 'judge', session },
            type: 'panel.preferred',
            payload: { panel: 'panel-1', judge: 1, session, preference: 'A', reason: 'r' },
          })
          return unavailable()
        },
      })
      const backup = backupFor(new Map(), () => defaultTurnResult())
      const result = await runnerFor(store, agent, {
        roles: JUDGE_ALTERNATE,
        runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
        sessionEnv: { AB_STORE: 'https://store.example', AB_TOKEN: 'runner-token' },
        delegateCredential: async () => 'judge-token',
      }).runPanel({ ...REQUEST, judges: 1 })
      expect(result.kind).toBe('judged')
      expect(backup.sessions.size).toBe(0)
    }
  })

  test('a preference racing the failed session end stops the chain', async () => {
    const store = await seeded()
    const agent = new ScriptedAgentRunner({ script: () => unavailable() })
    const backup = backupFor(new Map(), () => defaultTurnResult())
    let raced = false
    const result = await runnerFor(store, agent, {
      roles: JUDGE_ALTERNATE,
      runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
      // The primary's credential records just before its end lands.
      wrapStore: (scoped) =>
        new Proxy(scoped, {
          get(target, property, receiver) {
            if (property !== 'appendWithArtifacts') return Reflect.get(target, property, receiver)
            const append: BuildStore['appendWithArtifacts'] = async (slug, artifacts, build) => {
              if (artifacts[0]?.kind === 'transcript' && !raced) {
                raced = true
                const session = String(artifacts[0].metadata?.session)
                await scopeLocalStoreToJudgeSession(store, {
                  build: SLUG,
                  panel: 'panel-1',
                  judge: 1,
                  session,
                }).append(SLUG, {
                  actor: { kind: 'agent', role: 'judge', session },
                  type: 'panel.preferred',
                  payload: { panel: 'panel-1', judge: 1, session, preference: 'tie', reason: 'r' },
                })
              }
              return target.appendWithArtifacts(slug, artifacts, build)
            }
            return append
          },
        }),
    }).runPanel({ ...REQUEST, judges: 1 })
    expect(result.kind).toBe('judged')
    expect(backup.sessions.size).toBe(0)
    const events = panelEvents(await store.getEvents(SLUG))
    expect(events.filter((event) => event.type === 'panel.preferred')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'panel.judge-started')).toHaveLength(1)
  })

  test('an alternate whose executable is protected is refused before it launches', async () => {
    const store = await seeded()
    const agent = new ScriptedAgentRunner({ script: () => unavailable() })
    const backup = backupFor(new Map(), () => defaultTurnResult())
    let delegated = 0
    const result = await runnerFor(store, agent, {
      roles: JUDGE_ALTERNATE,
      runtimes: { backup: { runner: backup.runner, servesModels: [''] } },
      protectedExecutables: ['backup-cli'],
      sessionEnv: { AB_STORE: 'https://store.example', AB_TOKEN: 'runner-token' },
      delegateCredential: async () => {
        delegated += 1
        return 'judge-token'
      },
    }).runPanel({ ...REQUEST, judges: 1 })
    // The primary still runs; the refused alternate is never started, so the
    // primary's failure counts.
    expect(result).toEqual({
      kind: 'failed',
      reason: 'judge 1 failed 2 times; last outcome failed',
    })
    expect(backup.sessions.size).toBe(0)
    expect(delegated).toBe(2)
    const events = panelEvents(await store.getEvents(SLUG))
    expect(
      events.filter((event) => event.type === 'panel.judge-started').map((e) => e.payload.runner),
    ).toEqual(['scripted', 'scripted'])
    const ended = events.find((event) => event.type === 'panel.judge-ended')!
    const error = (ended.payload as { error?: string }).error!
    expect(error).toContain('provider overloaded')
    expect(error).toContain('alternate 1 (backup) refused')
    expect(error).not.toContain(WORKSPACE)
  })

  test('a reclaimed judge session closes its stream before it ends', async () => {
    const store = await seeded()
    const files: Files = new Map()
    const stream = await store
      .scopeBuild(SLUG)
      .createStream({ kind: 'build', build: SLUG }, 'session:s_dead')
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'panel.started',
      payload: {
        panel: REQUEST.id,
        candidate: REQUEST.candidate,
        baseline: REQUEST.baseline,
        harnessPin: REQUEST.harnessPin,
        purpose: REQUEST.purpose,
        rubric: REQUEST.rubric,
        harness: [...REQUEST.harness],
        judges: 1,
      },
    })
    await store.append(SLUG, {
      actor: KERNEL,
      type: 'panel.judge-started',
      payload: {
        panel: REQUEST.id,
        judge: 1,
        session: 's_dead',
        order: 'candidate-first',
        runner: 'backup',
        stream: stream.id,
      },
    })
    const calls: string[] = []
    const agent = judgeRunner(files, async (_ctx, prefer) => {
      await prefer('A')
      return defaultTurnResult()
    })
    const result = await runnerFor(store, agent, {
      files,
      wrapStore: (scoped) =>
        new Proxy(scoped, {
          get(target, property, receiver) {
            const member = Reflect.get(target, property, receiver)
            if (property === 'closeStream')
              return async (id: string, outcome: StreamOutcome) => {
                calls.push(`close ${id === stream.id ? 'dead' : 'other'} ${outcome}`)
                return target.closeStream(id, outcome)
              }
            if (property === 'append')
              return async (slug: string, write: Parameters<BuildStore['append']>[1]) => {
                if (write.type === 'panel.judge-ended')
                  calls.push(`end ${(write.payload as { outcome: string }).outcome}`)
                return target.append(slug, write)
              }
            return member
          },
        }),
    }).runPanel({ ...REQUEST, judges: 1 })
    expect(result.kind).toBe('judged')
    expect(calls.slice(0, 2)).toEqual(['close dead aborted', 'end reclaimed'])
    expect((await store.getStream(stream.id))?.status).toBe('closed')
  })
})
