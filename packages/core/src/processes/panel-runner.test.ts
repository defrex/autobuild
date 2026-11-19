import { describe, expect, test } from 'bun:test'
import type { EventPayload } from '../events/payloads'
import { PanelLogBuilder, panelStarted } from '../kernel/generators/panel-log'
import { advancePanel, type PanelOrder, type PanelRunState } from '../kernel/panel'
import type { Exec, ExecResult } from '../ports/workspace/git-worktree'
import { sessionEnv } from '../ports/runner/session-env'
import {
  TMPDIR_PROBE,
  checkJudgeRoot,
  checkJudgeExecutables,
  ESCAPING_LINKS_PROBE,
  EXECUTABLE_PROBE,
  insideProtected,
  REAL_ENTRY_PROBE,
  JUDGE_SKILL_INSTALLS,
  judgeAmbientAliases,
  NEUTRAL_ATTRIBUTES,
  PHYSICAL_PATHS_PROBE,
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
  /** `rev-parse --show-toplevel --git-common-dir` output lines. */
  repository?: [string, string]
  pinnedSkill?: boolean
  rootIsRepository?: boolean
  /** Discovery's stderr when it fails (default: not a git repository). */
  discoveryError?: string
  /** Where each executable resolves: [found, real]; absent = not found. */
  executables?: Record<string, [string, string] | null>
  escapingLinks?: string
  /** Where an ambient path physically resolves; absent = to itself, '' =
   * unresolvable. */
  physical?: Record<string, string>
  failCheckout?: boolean
  onLaunchCheck?: () => void
}): Exec {
  return async (cmd, { cwd, env }) => {
    opts.calls.push({ cmd, ...(cwd !== undefined ? { cwd } : {}), ...(env ? { env } : {}) })
    if (cmd[0] === 'sh' && cmd[2] === TMPDIR_PROBE) return ok(`${opts.tmp ?? '/tmp/t'}\n`)
    if (cmd[0] === 'sh' && cmd[2] === 'cd "$1" && pwd -P') return ok(`${cmd[4]}\n`)
    if (cmd[0] === 'sh' && cmd[2] === REAL_ENTRY_PROBE) return ok(`${cmd[4]}\n`)
    if (cmd[0] === 'sh' && cmd[2] === ESCAPING_LINKS_PROBE) return ok(opts.escapingLinks ?? '')
    if (cmd[0] === 'sh' && cmd[2] === PHYSICAL_PATHS_PROBE)
      return ok(
        cmd
          .slice(4)
          .map((path) => `${opts.physical?.[path] ?? path}\n`)
          .join(''),
      )
    if (cmd[0] === 'sh' && cmd[2] === EXECUTABLE_PROBE) {
      const name = cmd[5]!
      const found =
        opts.executables && name in opts.executables
          ? opts.executables[name]
          : [`/usr/bin/${name}`, `/usr/bin/${name}`]
      return found ? ok(`${found.join('\n')}\n`) : { stdout: '', stderr: '', exitCode: 3 }
    }
    if (cmd[0] !== 'git') return ok()
    const sub = cmd.find((part) => !part.startsWith('-') && part !== 'git' && !part.includes('='))
    if (sub === 'rev-parse' && cmd.includes('--show-toplevel'))
      return ok(`${(opts.repository ?? ['/ws', '/ws/.git']).join('\n')}\n`)
    if (sub === 'rev-parse' && cmd.includes('--git-common-dir')) return ok('/ws/.git\n')
    if (sub === 'rev-parse' && cmd.includes('--git-dir'))
      return opts.rootIsRepository
        ? ok('.git\n')
        : fail(
            opts.discoveryError ??
              'fatal: not a git repository (or any of the parent directories): .git',
          )
    if (sub === 'ls-tree') return ok(TREES[cmd.at(-1)!] ?? '')
    if (sub === 'cat-file' && cmd[2] === 'blob')
      return opts.pinnedSkill === false ? fail('path does not exist') : ok('pinned skill\n')
    if (sub === 'checkout-index' && opts.failCheckout) return fail('checkout broke')
    return ok()
  }
}

const LAUNCHER = '#!/usr/bin/env bun\nconsole.log("judge")\n'

function deps(exec: Exec, ambientEnv: Record<string, string> = {}): PanelDeps {
  return {
    exec,
    ambientEnv,
    distributionSkill: async () => 'distribution skill\n',
    judgeLauncher: async () => LAUNCHER,
    distributionRoot: '/opt/autobuild',
  }
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
): PanelLoopHooks & {
  launched: Array<{
    judge: number
    order: PanelOrder
    root: string
    binDir: string
    hide: readonly string[]
  }>
  reclaimed: Array<{ judge: number; session: string; root: string; stream?: string }>
  preflights: Array<(executable: string) => Promise<string | undefined>>
} {
  let next = 100
  const launched: Array<{
    judge: number
    order: PanelOrder
    root: string
    binDir: string
    hide: readonly string[]
  }> = []
  const reclaimed: Array<{ judge: number; session: string; root: string; stream?: string }> = []
  const preflights: Array<(executable: string) => Promise<string | undefined>> = []
  return {
    launched,
    reclaimed,
    preflights,
    async read(): Promise<PanelRunState> {
      let run: PanelRunState | undefined
      for (const event of log.events) run = advancePanel(run, event)
      return run!
    },
    async complete(judged: EventPayload<'panel.judged'>) {
      log.judged(judged.judge, judged.session, judged.order, judged.preference, judged.reason)
    },
    async reclaim(judge, session, root, stream) {
      reclaimed.push({ judge, session, root, ...(stream !== undefined ? { stream } : {}) })
      log.ended(judge, session, 'reclaimed')
    },
    async launch(judge, order, root, judgeLaunch, preflight) {
      preflights.push(preflight)
      launched.push({ judge, order, root, binDir: judgeLaunch.binDir, hide: judgeLaunch.hide })
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
    expect(final.cmd).toHaveLength(2 + 2 + INPUT.judges)
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
    expect(await checkJudgeRoot(deps(scriptedExec({ calls: [] })), '/tmp/t/r', ['/ws'])).toBe(
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
        ['/ws'],
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

describe('protected locations', () => {
  const materialWrites = (calls: Call[]) =>
    calls.filter(
      (call) =>
        (call.cmd[0] === 'git' && call.cmd.includes('init')) ||
        call.env?.AB_FILE_CONTENT !== undefined ||
        (call.cmd[0] === 'mkdir' && call.cmd.some((part) => part.includes('autobuild-'))),
    )

  test("a scratch base in a linked worktree's common directory, its main checkout or the store is refused before any material", async () => {
    const linked = { ...INPUT, workspacePath: '/wt', judges: 1 }
    for (const [tmp, localStore] of [
      ['/main/.git/tmp', undefined],
      ['/main/tmp', undefined],
      ['/state/store/tmp', '/state/store'],
    ] as const) {
      const calls: Call[] = []
      const exec = scriptedExec({ calls, tmp, repository: ['/wt', '/main/.git'] })
      const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
      const h = hooks(log, async () => 'A')
      const result = await runPanelJudges(
        deps(exec),
        { ...linked, ...(localStore !== undefined ? { localStore } : {}) },
        h,
      )
      expect(result).toMatchObject({ kind: 'failed' })
      const reason = (result as { reason: string }).reason
      expect(reason).toContain('point TMPDIR outside any repository')
      expect(reason).not.toContain(tmp)
      expect(materialWrites(calls)).toEqual([])
      expect(h.launched).toEqual([])
    }
  })

  test('discovery fails closed: only "not a git repository" counts as outside', async () => {
    const calls: Call[] = []
    const exec = scriptedExec({
      calls,
      discoveryError: "fatal: detected dubious ownership in repository at '/tmp/t'",
    })
    const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
    const h = hooks(log, async () => 'A')
    const result = await runPanelJudges(deps(exec), { ...INPUT, judges: 1 }, h)
    expect((result as { reason: string }).reason).toContain('could not be proven to be outside')
    expect(materialWrites(calls)).toEqual([])

    const clean: Call[] = []
    await runPanelJudges(
      deps(scriptedExec({ calls: clean })),
      { ...INPUT, judges: 1 },
      hooks(new PanelLogBuilder().started(panelStarted({ judges: 1 })), async () => 'A'),
    )
    const probes = clean.filter((call) => call.cmd.includes('--git-dir'))
    expect(probes.length).toBeGreaterThanOrEqual(2)
    for (const probe of probes) expect(probe.env?.GIT_DISCOVERY_ACROSS_FILESYSTEM).toBe('1')
  })

  test('the launcher is written beside the roots, passed to every launch and removed', async () => {
    const calls: Call[] = []
    const log = new PanelLogBuilder().started(panelStarted({ judges: 2 }))
    const h = hooks(log, async () => 'A')
    await runPanelJudges(deps(scriptedExec({ calls })), INPUT, h)
    const write = calls.find((call) => call.env?.AB_FILE_CONTENT === LAUNCHER)!
    const launcher = write.cmd[4]!
    expect(launcher).toMatch(/^\/tmp\/t\/autobuild-judge-bin-[0-9a-f]{16}\/ab$/)
    const binDir = launcher.slice(0, -'/ab'.length)
    expect(calls.some((call) => call.cmd.join(' ') === `chmod 0755 ${launcher}`)).toBe(true)
    for (const { root, binDir: launched } of h.launched) {
      expect(launched).toBe(binDir)
      expect(binDir.startsWith(`${root}/`)).toBe(false)
    }
    expect(calls.at(-1)!.cmd).toContain(binDir)
  })

  test('launcher text naming a protected location or the distribution is refused', async () => {
    for (const named of ['/ws/.git', '/opt/autobuild']) {
      const calls: Call[] = []
      const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
      const h = hooks(log, async () => 'A')
      const result = await runPanelJudges(
        { ...deps(scriptedExec({ calls })), judgeLauncher: async () => `import "${named}/x"` },
        { ...INPUT, judges: 1 },
        h,
      )
      expect((result as { reason: string }).reason).toContain('judge launcher names')
      expect(h.launched).toEqual([])
    }
  })

  test('an interpreter or runtime resolving only inside a protected location, or missing, is refused', async () => {
    const launch = { hide: ['/ws', '/ws/.git'], binDir: '/tmp/t/autobuild-judge-bin-x' }
    const check = (executables: Record<string, [string, string] | null>) =>
      checkJudgeExecutables(
        deps(scriptedExec({ calls: [], executables })),
        ['bun', 'claude'],
        launch,
      )
    expect(await check({})).toBeUndefined()
    expect(
      await check({ bun: ['/ws/node_modules/.bin/bun', '/ws/node_modules/bun/bin/bun'] }),
    ).toContain("the judge's bun executable resolves only inside a protected location")
    // A link outside that resolves into the repository is refused too.
    expect(
      await check({ claude: ['/usr/local/bin/claude', '/ws/node_modules/claude/cli.js'] }),
    ).toContain("the judge's claude executable resolves only inside a protected location")
    expect(await check({ claude: null })).toContain("the judge's claude executable was not found")
    // The probe searches the judge's filtered PATH.
    const calls: Call[] = []
    await checkJudgeExecutables(
      deps(scriptedExec({ calls }), { PATH: '/ws/node_modules/.bin:/usr/bin' }),
      ['bun'],
      launch,
    )
    expect(calls[0]!.cmd[4]).toBe(`${launch.binDir}:/usr/bin`)

    const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
    const h = hooks(log, async () => 'A')
    const result = await runPanelJudges(
      deps(scriptedExec({ calls: [], executables: { pi: ['/ws/bin/pi', '/ws/bin/pi'] } })),
      { ...INPUT, judges: 1, runtimeExecutable: 'pi' },
      h,
    )
    expect((result as { reason: string }).reason).toContain("the judge's pi executable")
    expect(h.launched).toEqual([])
  })

  test("each launch gets a preflight that checks an alternate against the run's protections", async () => {
    const calls: Call[] = []
    const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
    const h = hooks(log, async () => 'A')
    await runPanelJudges(
      deps(
        scriptedExec({
          calls,
          executables: { codex: ['/usr/local/bin/codex', '/ws/node_modules/codex/cli.js'] },
        }),
        { PATH: '/ws/node_modules/.bin:/usr/bin' },
      ),
      { ...INPUT, judges: 1 },
      h,
    )
    const preflight = h.preflights[0]!
    expect(await preflight('backup')).toBeUndefined()
    const refused = await preflight('codex')
    expect(refused).toContain(
      "the judge's codex executable resolves only inside a protected location",
    )
    expect(refused).not.toContain('/ws')
    // It searches the same filtered PATH as the primary's check.
    const probes = calls.filter((call) => call.cmd[2] === EXECUTABLE_PROBE)
    expect(probes.at(-1)!.cmd[4]).toBe(probes[0]!.cmd[4])
    expect(probes.at(-1)!.cmd[4]).not.toContain('/ws')
  })

  test('an inherited path reaching a protected location through a symlink is hidden as well', async () => {
    const ambient = {
      PATH: '/usr/bin:/alias/node_modules/.bin',
      INIT_CWD: '/alias',
      npm_package_json: '/alias/package.json',
      FLAGS: '--dir=/link/ws/sub --other',
      CONFIG: '/home/me/config.json',
      DIRECT: '/ws/inside',
      CFLAGS: '-O2 -I/alias/include',
      LITERAL: '-isystem/ws/include',
      MULTILINE: 'root=/alias\nmode=development',
    }
    const physical = {
      '/alias': '/ws',
      '/alias/node_modules/.bin': '/ws/node_modules/.bin',
      '/alias/package.json': '/ws/package.json',
      '/link/ws/sub': '/ws/sub',
      '/home/me/config.json': '/home/me/config.json',
      '/alias/include': '/ws/include',
    }
    const calls: Call[] = []
    const aliases = await judgeAmbientAliases(deps(scriptedExec({ calls, physical }), ambient), [
      '/ws',
      '/ws/.git',
    ])
    // An embedded path is hidden by the piece it starts in, and a multiline
    // value line by line.
    expect(aliases.sort()).toEqual([
      '-I/alias/include',
      '-O2 -I/alias/include',
      '-isystem/ws/include',
      '/alias',
      '/alias/node_modules/.bin',
      '/alias/package.json',
      '/link/ws/sub',
      'root=/alias',
    ])
    // A path already naming a protected location needs no resolution.
    const probe = calls.find((call) => call.cmd[2] === PHYSICAL_PATHS_PROBE)!
    expect(probe.cmd).not.toContain('/ws/inside')
    expect(probe.cmd.slice(4).some((arg) => arg.includes('\n'))).toBe(false)
    const env = sessionEnv({ AB_JUDGE: 'b:p:1' }, ambient, {
      hide: ['/ws', '/ws/.git', ...aliases],
      binDir: '/scratch/bin',
    })
    expect(Object.keys(env).sort()).toEqual(['AB_JUDGE', 'CONFIG', 'PATH'])

    // A path that cannot be resolved is hidden, failing closed.
    expect(
      await judgeAmbientAliases(
        deps(scriptedExec({ calls: [], physical: { '/home/me/config.json': '' } }), {
          CONFIG: '/home/me/config.json',
        }),
        ['/ws'],
      ),
    ).toEqual(['/home/me/config.json'])

    // Every launch hides the aliases with the real locations.
    const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
    const h = hooks(log, async () => 'A')
    await runPanelJudges(
      deps(scriptedExec({ calls: [], physical }), ambient),
      { ...INPUT, judges: 1 },
      h,
    )
    expect(h.launched[0]!.hide).toEqual(expect.arrayContaining(['/ws', '/alias', '/link/ws/sub']))
  })

  test('a failed resolution of the inherited paths fails the run before any session', async () => {
    const scripted = scriptedExec({ calls: [] })
    const exec: Exec = async (cmd, opts) =>
      cmd[2] === PHYSICAL_PATHS_PROBE ? fail('sh: broken') : scripted(cmd, opts)
    const log = new PanelLogBuilder().started(panelStarted({ judges: 1 }))
    const h = hooks(log, async () => 'A')
    const result = await runPanelJudges(
      deps(exec, { INIT_CWD: '/alias' }),
      { ...INPUT, judges: 1 },
      h,
    )
    expect((result as { reason: string }).reason).toContain('inherited environment')
    expect(h.launched).toEqual([])
  })

  test('insideProtected matches a location and what is under it, not a sibling', () => {
    expect(insideProtected('/ws', ['/ws'])).toBe('/ws')
    expect(insideProtected('/ws/.git/x', ['/a', '/ws/.git'])).toBe('/ws/.git')
    expect(insideProtected('/ws-other', ['/ws'])).toBeUndefined()
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
      .judgeStarted(3, 's_3', 'candidate-first', 'panel-1', { stream: 'st_3' })
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
    // Reclaim gets each crashed session's deterministic root, before the saved
    // preference is completed, so a preference imported then completes too.
    expect(h.reclaimed.map(({ judge, session, stream }) => [judge, session, stream])).toEqual([
      [2, 's_2', undefined],
      [3, 's_3', 'st_3'],
    ])
    expect(h.reclaimed[0]!.root).toMatch(/^\/tmp\/t\/autobuild-judge-[0-9a-f]{16}$/)
    const reclaimedAt = log.events.findIndex(
      (event) => event.type === 'panel.judge-ended' && event.payload.session === 's_2',
    )
    const completedAt = log.events.findIndex(
      (event) => event.type === 'panel.judged' && event.payload.session === 's_2',
    )
    expect(reclaimedAt).toBeGreaterThan(-1)
    expect(reclaimedAt).toBeLessThan(completedAt)
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
