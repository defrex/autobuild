import { describe, expect, test } from 'bun:test'
import type { EventPayload } from '../events/payloads'
import { PanelLogBuilder, panelStarted } from '../kernel/generators/panel-log'
import { advancePanel, type PanelOrder, type PanelRunState } from '../kernel/panel'
import type { Exec, ExecResult } from '../ports/workspace/git-worktree'
import {
  TMPDIR_PROBE,
  checkJudgeRoot,
  ESCAPING_LINKS_PROBE,
  JUDGE_SKILL_INSTALLS,
  NEUTRAL_ATTRIBUTES,
  PINNED_JUDGE_SKILL,
  runPanelJudges,
  type PanelDeps,
  type PanelLoopHooks,
  type PanelRunInput,
} from './panel-runner'

const CANDIDATE = 'c'.repeat(40)
const BASELINE = 'b'.repeat(40)
const PIN = 'a'.repeat(40)
const SHAS = [CANDIDATE, BASELINE, PIN]
const OID = (char: string) => char.repeat(40)

interface Call {
  cmd: string[]
  cwd?: string
  env?: Record<string, string | undefined>
}

const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 })
const fail = (stderr = 'fatal'): ExecResult => ({ stdout: '', stderr, exitCode: 128 })

/** The pin's harness has the rubric and a fixture; the candidate edited the
 * rubric and added a harness file; the baseline equals the pin's harness. */
const TREES: Record<string, string> = {
  [PIN]: `100644 blob ${OID('1')}\tevals/rubric.md\u0000100644 blob ${OID('2')}\tevals/fixture.txt\u0000100644 blob ${OID('3')}\tdoc.md\u0000`,
  [CANDIDATE]: `100644 blob ${OID('9')}\tevals/rubric.md\u0000100644 blob ${OID('2')}\tevals/fixture.txt\u0000100644 blob ${OID('8')}\tevals/added.md\u0000100644 blob ${OID('4')}\tdoc.md\u0000`,
  [BASELINE]: `100644 blob ${OID('1')}\tevals/rubric.md\u0000100644 blob ${OID('2')}\tevals/fixture.txt\u0000100644 blob ${OID('5')}\tdoc.md\u0000`,
}

function scriptedExec(opts: {
  calls: Call[]
  tmp?: string
  workspace?: string
  pinnedSkill?: boolean
  rootIsRepository?: boolean
  escapingLinks?: string
  failCheckout?: boolean
  onLaunchCheck?: () => void
}): Exec {
  return async (cmd, { cwd, env }) => {
    opts.calls.push({ cmd, ...(cwd !== undefined ? { cwd } : {}), ...(env ? { env } : {}) })
    if (cmd[0] === 'sh' && cmd[2] === TMPDIR_PROBE) return ok(`${opts.tmp ?? '/tmp/t'}\n`)
    if (cmd[0] === 'sh' && cmd[2] === 'cd "$1" && pwd -P') return ok(`${cmd[4]}\n`)
    if (cmd[0] === 'sh' && cmd[2] === ESCAPING_LINKS_PROBE) return ok(opts.escapingLinks ?? '')
    if (cmd[0] !== 'git') return ok()
    const sub = cmd.find((part) => !part.startsWith('-') && part !== 'git' && !part.includes('='))
    if (sub === 'rev-parse' && cmd.includes('--git-common-dir')) return ok('/ws/.git\n')
    if (sub === 'rev-parse' && cmd.includes('--git-dir'))
      return opts.rootIsRepository ? ok('.git\n') : fail('not a git repository')
    if (sub === 'ls-tree') return ok(TREES[cmd.at(-1)!] ?? '')
    if (sub === 'cat-file' && cmd[2] === 'blob')
      return opts.pinnedSkill === false ? fail('path does not exist') : ok('pinned skill\n')
    if (sub === 'checkout-index' && opts.failCheckout) return fail('checkout broke')
    return ok()
  }
}

function deps(exec: Exec, ambientEnv: Record<string, string> = {}): PanelDeps {
  return { exec, ambientEnv, distributionSkill: async () => 'distribution skill\n' }
}

const INPUT: PanelRunInput = {
  workspacePath: '/ws',
  build: 'b-1',
  panel: 'panel-1',
  candidate: CANDIDATE,
  baseline: BASELINE,
  harnessPin: PIN,
  harness: ['evals/**'],
  purpose: 'clear prose',
  rubric: 'evals/rubric.md',
  judges: 2,
}

/** An in-memory log behind the loop's hooks; `launch` is scripted. */
function hooks(
  log: PanelLogBuilder,
  launch: (judge: number, order: PanelOrder, root: string, session: string) => Promise<string>,
  random: () => number = () => 0.25,
): PanelLoopHooks & { launched: Array<{ judge: number; order: PanelOrder; root: string }> } {
  let next = 100
  const launched: Array<{ judge: number; order: PanelOrder; root: string }> = []
  return {
    launched,
    async read(): Promise<PanelRunState> {
      let run: PanelRunState | undefined
      for (const event of log.events) run = advancePanel(run, event)
      return run!
    },
    async complete(judged: EventPayload<'panel.judged'>) {
      log.judged(judged.judge, judged.session, judged.order, judged.preference, judged.reason)
    },
    async reclaim(judge, session) {
      log.ended(judge, session, 'reclaimed')
    },
    async launch(judge, order, root) {
      launched.push({ judge, order, root })
      next += 1
      const session = `s_${next}`
      log.judgeStarted(judge, session, order)
      const preference = await launch(judge, order, root, session)
      if (preference === 'A' || preference === 'B' || preference === 'tie') {
        log.preferred(judge, session, preference)
        log.judged(judge, session, order, preference)
        log.ended(judge, session, 'completed')
        return 'completed'
      }
      log.ended(judge, session, preference as 'no-terminal')
      return preference as 'no-terminal'
    },
    random,
  }
}

describe('panel materialization', () => {
  test('prepares, materializes, seals and checks before any session launches', async () => {
    const calls: Call[] = []
    const log = new PanelLogBuilder().started(panelStarted({ judges: 2 }))
    let atLaunch = -1
    const h = hooks(log, async () => {
      if (atLaunch < 0) atLaunch = calls.length
      return 'A'
    })
    const result = await runPanelJudges(
      deps(scriptedExec({ calls }), { GIT_DIR: '/ws/.git', GIT_WORK_TREE: '/ws' }),
      INPUT,
      h,
    )
    expect(result.kind).toBe('judged')
    const material = '/tmp/t/autobuild-panel-'
    const sealed = calls.findIndex(
      (call) => call.cmd[0] === 'rm' && call.cmd.length === 3 && call.cmd[2]!.startsWith(material),
    )
    const lastCheck = calls.findLastIndex((call) => call.cmd.includes('--git-dir'))
    expect(sealed).toBeGreaterThan(0)
    expect(lastCheck).toBeGreaterThan(sealed)
    expect(atLaunch).toBeGreaterThan(lastCheck)
    // The material is created fresh, with the alternates and neutral attributes.
    const writes = calls.filter((call) => call.cmd[0] === 'sh' && call.env?.AB_FILE_CONTENT)
    const alternates = writes.find((call) => call.cmd[4]!.endsWith('/objects/info/alternates'))
    expect(alternates?.env?.AB_FILE_CONTENT).toBe('/ws/.git/objects\n')
    expect(alternates?.cmd[4]?.startsWith(material)).toBe(true)
    const attributes = writes.find((call) => call.cmd[4]!.endsWith('/info/attributes'))
    expect(attributes?.env?.AB_FILE_CONTENT).toBe(NEUTRAL_ATTRIBUTES)
    // Every Git command clears the inherited selection.
    for (const call of calls.filter((c) => c.cmd[0] === 'git')) {
      expect(call.env).toBeDefined()
      expect('GIT_CEILING_DIRECTORIES' in call.env!).toBe(true)
      expect(call.env!.GIT_CEILING_DIRECTORIES).toBeUndefined()
      if (!call.cmd.includes('read-tree') && !call.cmd.includes('update-index'))
        expect(call.env!.GIT_INDEX_FILE ?? undefined).toSatisfy(
          (value) => value === undefined || call.cmd.includes('checkout-index'),
        )
    }
    // Nothing named by a path or index reveals a side or a SHA.
    for (const call of calls) {
      const paths = [call.cwd, call.env?.GIT_INDEX_FILE, call.env?.GIT_WORK_TREE, call.env?.GIT_DIR]
      for (const path of [...paths, ...call.cmd.filter((part) => part.startsWith('/tmp/'))]) {
        if (path === undefined) continue
        expect(path).not.toMatch(/candidate|baseline/)
        for (const sha of SHAS) expect(path).not.toContain(sha)
      }
    }
    // Every judge root and the material are removed at the end.
    const final = calls.at(-1)!
    expect(final.cmd[0]).toBe('rm')
    expect(final.cmd.slice(2).every((path) => path.startsWith('/tmp/t/autobuild-'))).toBe(true)
    expect(final.cmd).toHaveLength(2 + 1 + INPUT.judges)
  })

  test('the pin side skips the overlay; another side removes and restores harness paths', async () => {
    const calls: Call[] = []
    const log = new PanelLogBuilder().started(panelStarted({ judges: 1, baseline: PIN }))
    await runPanelJudges(
      deps(scriptedExec({ calls })),
      { ...INPUT, judges: 1, baseline: PIN },
      hooks(log, async () => 'tie'),
    )
    const updates = calls.filter((call) => call.cmd.includes('update-index'))
    expect(updates.map((call) => call.env?.GIT_INDEX_FILE)).toEqual([
      expect.stringMatching(/\/index-1$/),
      expect.stringMatching(/\/index-1$/),
    ])
    expect(updates[0]!.cmd.slice(-3)).toEqual(['--force-remove', '--', 'evals/added.md'])
    expect(updates[1]!.cmd).toContain(`100644,${OID('1')},evals/rubric.md`)
    expect(updates[1]!.cmd).toContain(`100644,${OID('2')},evals/fixture.txt`)
    expect(updates[1]!.cmd.join(' ')).not.toContain('doc.md')
  })

  test('removals and restores are batched', async () => {
    const many = Array.from(
      { length: 450 },
      (_, index) => `100644 blob ${OID('7')}\tevals/f${index}.md\u0000`,
    ).join('')
    const calls: Call[] = []
    const exec = scriptedExec({ calls })
    const batchedExec: Exec = async (cmd, opts) => {
      if (!cmd.includes('ls-tree') || cmd.at(-1) !== CANDIDATE) return exec(cmd, opts)
      calls.push({ cmd })
      return ok(many)
    }
    const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
    await runPanelJudges(
      deps(batchedExec),
      { ...INPUT, judges: 1 },
      hooks(log, async () => 'A'),
    )
    const removals = calls.filter((call) => call.cmd.includes('--force-remove'))
    expect(removals.map((call) => call.cmd.length - 8)).toEqual([200, 200, 50])
  })

  test('each label checks out the side its order names, A first, then B', async () => {
    for (const [random, order] of [
      [0.1, 'candidate-first'],
      [0.9, 'baseline-first'],
    ] as const) {
      const calls: Call[] = []
      const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
      const h = hooks(
        log,
        async () => 'A',
        () => random,
      )
      await runPanelJudges(deps(scriptedExec({ calls })), { ...INPUT, judges: 1 }, h)
      expect(h.launched[0]!.order).toBe(order)
      const checkouts = calls.filter((call) => call.cmd.includes('checkout-index'))
      expect(checkouts.map((call) => call.env!.GIT_WORK_TREE!.split('/').at(-1))).toEqual([
        'A',
        'B',
      ])
      // index-1 holds the candidate, index-2 the baseline.
      const indexes = checkouts.map((call) => call.env!.GIT_INDEX_FILE!.split('/').at(-1))
      expect(indexes).toEqual(
        order === 'candidate-first' ? ['index-1', 'index-2'] : ['index-2', 'index-1'],
      )
    }
  })

  test('writes the brief and installs the pinned skill, or the distribution fallback', async () => {
    for (const pinnedSkill of [true, false]) {
      const calls: Call[] = []
      const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
      await runPanelJudges(
        deps(scriptedExec({ calls, pinnedSkill })),
        { ...INPUT, judges: 1 },
        hooks(log, async () => 'A'),
      )
      const blob = calls.find((call) => call.cmd[2] === 'blob')!
      expect(blob.cmd[3]).toBe(`${PIN}:${PINNED_JUDGE_SKILL}`)
      expect(blob.cwd).toBe('/ws')
      const writes = calls.filter((call) => call.env?.AB_FILE_CONTENT !== undefined)
      for (const install of JUDGE_SKILL_INSTALLS) {
        const write = writes.find((call) => call.cmd[4]!.endsWith(install))!
        expect(write.env!.AB_FILE_CONTENT).toBe(
          pinnedSkill ? 'pinned skill\n' : 'distribution skill\n',
        )
      }
      const brief = writes.find((call) => call.cmd[4]!.endsWith('.ab/judge/brief.json'))!
      expect(JSON.parse(brief.env!.AB_FILE_CONTENT!)).toEqual({
        judge: 1,
        purpose: 'clear prose',
        rubric: 'evals/rubric.md',
      })
    }
  })

  test('a root inside the workspace or a repository fails before any session', async () => {
    for (const exec of [
      scriptedExec({ calls: [], tmp: '/ws/tmp' }),
      scriptedExec({ calls: [], rootIsRepository: true }),
    ]) {
      const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
      const h = hooks(log, async () => 'A')
      const result = await runPanelJudges(deps(exec), { ...INPUT, judges: 1 }, h)
      expect(result).toMatchObject({ kind: 'failed' })
      expect((result as { reason: string }).reason).toContain('point TMPDIR outside any repository')
      expect(h.launched).toEqual([])
    }
    expect(await checkJudgeRoot(deps(scriptedExec({ calls: [] })), '/tmp/t/r', '/ws')).toBe(
      undefined,
    )
  })

  test('a symlink resolving outside a judge root fails before any session', async () => {
    const calls: Call[] = []
    const exec = scriptedExec({
      calls,
      escapingLinks: '/tmp/t/autobuild-judge-x/A/source\n/tmp/t/autobuild-judge-x/B/source\n',
    })
    const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
    const h = hooks(log, async () => 'A')
    const result = await runPanelJudges(deps(exec), { ...INPUT, judges: 1 }, h)
    expect(result).toMatchObject({ kind: 'failed' })
    expect((result as { reason: string }).reason).toContain('resolve outside its judge root')
    expect(h.launched).toEqual([])
    const probe = calls.find((call) => call.cmd[2] === ESCAPING_LINKS_PROBE)!
    expect(probe.cmd[4]).toMatch(/^\/tmp\/t\/autobuild-judge-/)
    expect(
      await checkJudgeRoot(
        deps(scriptedExec({ calls: [], escapingLinks: '/tmp/t/r/A/source\n' })),
        '/tmp/t/r',
        '/ws',
      ),
    ).toBe('a variant holds symlinks that resolve outside its judge root: A/source')
  })

  test('a preparation failure fails the run with the output tail and cleans up', async () => {
    const calls: Call[] = []
    const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
    const h = hooks(log, async () => 'A')
    const result = await runPanelJudges(
      deps(scriptedExec({ calls, failCheckout: true })),
      { ...INPUT, judges: 1 },
      h,
    )
    expect(result).toEqual({
      kind: 'failed',
      reason: 'checking out variant A failed',
      outputTail: 'checkout broke',
    })
    expect(h.launched).toEqual([])
    expect(calls.at(-1)!.cmd[0]).toBe('rm')
  })
})

describe('the panel loop', () => {
  test('retries a judge once, then fails naming it and its last outcome', async () => {
    const log = new PanelLogBuilder().started(panelStarted({ judges: 2 }))
    const h = hooks(log, async (judge) => (judge === 2 ? 'no-terminal' : 'A'))
    const result = await runPanelJudges(deps(scriptedExec({ calls: [] })), INPUT, h)
    expect(result).toEqual({
      kind: 'failed',
      reason: 'judge 2 failed 2 times; last outcome no-terminal',
    })
    expect(h.launched.map((launch) => launch.judge)).toEqual([1, 2, 2])
  })

  test('resume completes a saved preference and reruns only the judge without one', async () => {
    const calls: Call[] = []
    const log = new PanelLogBuilder()
      .started(panelStarted({ judges: 3 }))
      .judge(1, 's_1', 'candidate-first', 'A')
      .judgeStarted(2, 's_2', 'baseline-first')
      .preferred(2, 's_2', 'A', 'saved')
      .judgeStarted(3, 's_3', 'candidate-first')
    const h = hooks(log, async () => 'tie')
    const result = await runPanelJudges(deps(scriptedExec({ calls })), { ...INPUT, judges: 3 }, h)
    expect(h.launched.map((launch) => launch.judge)).toEqual([3])
    expect(result).toMatchObject({ kind: 'judged' })
    const judged = (result as { judgments: Array<EventPayload<'panel.judged'>> }).judgments
    expect(judged.map((j) => [j.judge, j.session, j.order, j.preference])).toEqual([
      [1, 's_1', 'candidate-first', 'A'],
      [2, 's_2', 'baseline-first', 'A'],
      [3, 's_101', 'candidate-first', 'tie'],
    ])
    expect((result as { winRate: number }).winRate).toBe(0.5)
    const ended = log.events.filter((event) => event.type === 'panel.judge-ended')
    expect(
      ended.slice(1, 3).map((event) => [event.payload.session, event.payload.outcome]),
    ).toEqual([
      ['s_2', 'reclaimed'],
      ['s_3', 'reclaimed'],
    ])
    // Stale roots of the resumed judges are removed before they are recreated.
    const root = h.launched[0]!.root
    expect(calls.findIndex((call) => call.cmd[0] === 'rm' && call.cmd[2] === root)).toBeLessThan(
      calls.findIndex((call) => call.cmd[0] === 'mkdir' && call.cmd[2] === `${root}/A`),
    )
  })

  test('shutdown returns interrupted without launching', async () => {
    const controller = new AbortController()
    controller.abort()
    const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
    const h = { ...hooks(log, async () => 'A'), shutdownSignal: controller.signal }
    const result = await runPanelJudges(
      deps(scriptedExec({ calls: [] })),
      { ...INPUT, judges: 1 },
      h,
    )
    expect(result).toEqual({ kind: 'interrupted' })
  })
})
