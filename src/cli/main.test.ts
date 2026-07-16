/**
 * `runCli` routing tests (SPEC §8.2): argv dispatch, exit codes, errors as
 * agent feedback on stderr — plus a full walk of §8.7's implementer session
 * (context → observe → done) over fakes, asserting the final event sequence.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KERNEL } from '../events/envelope'
import type { MemoryBuildStore } from '../store/memory'
import { runCli, SESSIONLESS_COMMANDS } from './main'
import {
  BRANCH,
  BUILD,
  commitFile,
  initWorkspaceRepo,
  makeDeps,
  makeEnv,
  runGit,
  seedStore,
  type TestDeps,
} from './testkit'

let tmp: string
let store: MemoryBuildStore

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-main-'))
  store = await seedStore()
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
  await store.close()
})

function deps(): TestDeps {
  return makeDeps({ store, env: makeEnv({ phase: 'plan', round: 1 }) })
}

describe('runCli — routing and exit codes', () => {
  test('no arguments prints help to stderr and exits 1', async () => {
    const d = deps()
    expect(await runCli([], d)).toBe(1)
    expect(d.err.join('\n')).toContain('ab — the agent↔store channel')
    expect(d.out).toEqual([])
  })

  test('help prints the §8.2 table to stdout and exits 0', async () => {
    const d = deps()
    expect(await runCli(['help'], d)).toBe(0)
    const help = d.out.join('\n')
    for (const command of ['ab context', 'ab artifact put', 'ab observe', 'ab server', 'ab done', 'ab verdict', 'ab escalate']) {
      expect(help).toContain(command)
    }
  })

  test('help documents the status commands, their defaults, and their flags', async () => {
    const d = deps()
    expect(await runCli(['help'], d)).toBe(0)
    const help = d.out.join('\n')
    expect(help).toContain('ab builds [--queued] [--all] [--json] [--store <ref>]')
    expect(help).toContain('ab build status <slug> [--events <n>] [--json] [--store <ref>]')
    expect(help).toContain('running, paused, blocked')
  })

  test('an unknown command prints the help and exits 1', async () => {
    const d = deps()
    expect(await runCli(['frobnicate'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('unknown command "frobnicate"')
    expect(d.err.join('\n')).toContain('ab context')
  })

  test('an unknown flag is a usage error on stderr with exit 1', async () => {
    const d = deps()
    expect(await runCli(['done', '--force'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('unknown flag --force')
  })

  test('errors surface as agent feedback: wrong verdict vocabulary names what is accepted', async () => {
    const d = makeDeps({ store, env: makeEnv({ phase: 'code-review', round: 1 }) })
    expect(await runCli(['verdict', 'pass'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('code-review accepts: approve|revise|escalate')
  })

  test('verdict without a kind prints usage and exits 1', async () => {
    const d = makeDeps({ store, env: makeEnv({ phase: 'code-review' }) })
    expect(await runCli(['verdict'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('usage: ab verdict <approve|revise|escalate|pass|fail>')
  })
})

describe('SESSIONLESS_COMMANDS', () => {
  // bin/ab.ts routes on this set; a command missing from it goes through
  // resolveCliEnv and exits 1 on absent AB_* before routing. runCli tests
  // cannot see that failure — they never traverse the binary — so the set
  // itself is asserted here, and the binary is smoke-tested in bin-ab.test.ts.
  test('contains the status commands', () => {
    expect(SESSIONLESS_COMMANDS.has('builds')).toBe(true)
    expect(SESSIONLESS_COMMANDS.has('build')).toBe(true)
  })

  test('every literal formerly hardcoded in bin/ab.ts survives the lift', () => {
    for (const command of ['init', 'upgrade', 'ticket', 'dispatch', 'help', '--help', '-h']) {
      expect(SESSIONLESS_COMMANDS.has(command)).toBe(true)
    }
  })

  test('session commands are absent — they require AB_* and must not route sessionless', () => {
    for (const command of ['context', 'done', 'verdict', 'escalate', 'observe', 'artifact', 'server']) {
      expect(SESSIONLESS_COMMANDS.has(command)).toBe(false)
    }
  })
})

describe('runCli — builds / build status routing', () => {
  /** Sessionless deps: no store, no env, no forge — exactly what bin/ab.ts's
   * sessionless branch passes. If these commands ever reach requireSession,
   * these tests fail with its AB_* error. */
  function sessionlessDeps(): {
    workspacePath: string
    stdout: (line: string) => void
    stderr: (line: string) => void
    exec: TestDeps['exec']
    processEnv: Record<string, string | undefined>
    out: string[]
    err: string[]
  } {
    const out: string[] = []
    const err: string[] = []
    return {
      workspacePath: tmp,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      exec: async () => ({ stdout: '', stderr: 'not a git repo', exitCode: 128 }),
      processEnv: { AB_STORE: join(tmp, 'store') },
      out,
      err,
    }
  }

  test('ab builds routes with NO AB_* env — it never hits requireSession', async () => {
    const d = sessionlessDeps()
    expect(await runCli(['builds'], d)).toBe(0)
    expect(d.err.join('\n')).not.toContain('runs inside a build session')
    // An empty store for this repo: the honest empty line, naming the filter.
    expect(d.out.join('\n')).toContain('no active builds')
  })

  test('ab builds --all reports the widened filter in its empty line', async () => {
    const d = sessionlessDeps()
    expect(await runCli(['builds', '--all'], d)).toBe(0)
    expect(d.out.join('\n')).toContain('no builds for')
  })

  test('an unknown slug exits 1 and names the slug and how to list builds', async () => {
    const d = sessionlessDeps()
    expect(await runCli(['build', 'status', 'no-such-build'], d)).toBe(1)
    const err = d.err.join('\n')
    expect(err).toContain('no-such-build')
    expect(err).toContain('ab builds --all')
  })

  test('a non-positive or non-numeric --events count is an actionable error', async () => {
    for (const value of ['0', '-1', 'abc', '1.5']) {
      const d = sessionlessDeps()
      expect(await runCli(['build', 'status', 'b1', '--events', value], d)).toBe(1)
      expect(d.err.join('\n')).toContain('--events requires a positive integer')
    }
  })

  test('--events with no value is a usage error', async () => {
    const d = sessionlessDeps()
    expect(await runCli(['build', 'status', 'b1', '--events'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('--events requires a positive integer')
  })

  test('--store with no value is a usage error', async () => {
    const d = sessionlessDeps()
    expect(await runCli(['builds', '--store'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('--store requires a value')
  })

  // Without the flag-shaped-value guard this exits 0: --json is swallowed as
  // the store REF, a local store is created on demand in a directory named
  // "--json", and the caller who asked for JSON gets human text and a
  // plausible-looking empty list. A wrong answer beats an error only if you
  // never notice it.
  test('--store followed by another flag is an error, not a store named --json', async () => {
    const d = sessionlessDeps()
    expect(await runCli(['builds', '--store', '--json'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('--store requires a value')
    expect(d.err.join('\n')).toContain('--json')
    expect(d.out).toEqual([])
  })

  test('--store followed by another flag is an error on build status too', async () => {
    const d = sessionlessDeps()
    expect(await runCli(['build', 'status', 'b1', '--store', '--json'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('--store requires a value')
    expect(d.out).toEqual([])
  })

  test('--events followed by another flag is an error', async () => {
    const d = sessionlessDeps()
    expect(await runCli(['build', 'status', 'b1', '--events', '--json'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('--events requires a positive integer')
    expect(d.out).toEqual([])
  })

  test('an unknown flag on either command exits 1', async () => {
    const d1 = sessionlessDeps()
    expect(await runCli(['builds', '--frobnicate'], d1)).toBe(1)
    expect(d1.err.join('\n')).toContain('unknown argument "--frobnicate"')

    const d2 = sessionlessDeps()
    expect(await runCli(['build', 'status', 'b1', '--frobnicate'], d2)).toBe(1)
    expect(d2.err.join('\n')).toContain('unknown argument "--frobnicate"')
  })

  test('ab build with no or unknown subcommand prints usage', async () => {
    const d1 = sessionlessDeps()
    expect(await runCli(['build'], d1)).toBe(1)
    expect(d1.err.join('\n')).toContain('usage: ab build status <slug>')

    const d2 = sessionlessDeps()
    expect(await runCli(['build', 'frobnicate'], d2)).toBe(1)
    expect(d2.err.join('\n')).toContain('usage: ab build status <slug>')
  })

  test('ab build status with no slug prints usage', async () => {
    const d = sessionlessDeps()
    expect(await runCli(['build', 'status'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('usage: ab build status <slug>')
  })

  // The flag-set leakage guard: --store/--events are parsed locally by these
  // commands, so they must NOT have become legal on session commands via
  // main's module-global VALUE_FLAGS.
  test('the new flags did not leak into the session commands\' flag sets', async () => {
    const d1 = deps()
    expect(await runCli(['done', '--store', '/tmp/x'], d1)).toBe(1)
    expect(d1.err.join('\n')).toContain('unknown flag --store')

    const d2 = deps()
    expect(await runCli(['observe', '--kind', 'followup', '--events', '3', 'x'], d2)).toBe(1)
    expect(d2.err.join('\n')).toContain('unknown flag --events')
  })
})

describe('runCli — context', () => {
  test('context --json prints the manifest as parseable JSON', async () => {
    const workspace = join(tmp, 'ws-json')
    await initWorkspaceRepo(workspace)
    const d = makeDeps({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })
    expect(await runCli(['context', '--json'], d)).toBe(0)
    const manifest = JSON.parse(d.out.join('\n'))
    expect(manifest.build).toBe(BUILD)
    expect(manifest.phase).toBe('plan')
    expect(manifest.required).toEqual(['plan'])
    expect(existsSync(join(workspace, '.ab', 'context.json'))).toBe(true)
  })

  test('context without --json prints the human summary', async () => {
    const workspace = join(tmp, 'ws-human')
    await initWorkspaceRepo(workspace)
    const d = makeDeps({
      store,
      env: makeEnv({ phase: 'plan', round: 1 }),
      workspacePath: workspace,
    })
    expect(await runCli(['context'], d)).toBe(0)
    const output = d.out.join('\n')
    expect(output).toContain(`context materialized for ${BUILD} — plan@1`)
    expect(output).toContain('required deposits: plan')
    expect(output).toContain('spec.md — spec@0')
  })
})

describe('runCli — artifact and observe', () => {
  test('artifact put prints the assigned rev; get writes the content to stdout', async () => {
    const file = join(tmp, 'plan.md')
    await writeFile(file, '# The plan\n')
    const d = deps()

    expect(await runCli(['artifact', 'put', 'plan', file], d)).toBe(0)
    expect(d.out).toEqual(['0'])

    const getter = deps()
    expect(await runCli(['artifact', 'get', 'plan@0'], getter)).toBe(0)
    expect(getter.out).toEqual(['# The plan\n'])
  })

  test('artifact with a bad subcommand prints usage and exits 1', async () => {
    const d = deps()
    expect(await runCli(['artifact', 'list'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('usage: ab artifact <put|get>')
  })

  test('observe requires --kind', async () => {
    const d = deps()
    expect(await runCli(['observe', 'a summary'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('requires --kind')
  })

  test('observe records and prints the stamped id; flags split on commas', async () => {
    const d = makeDeps({ store, env: makeEnv({ phase: 'implement', round: 1 }) })
    expect(
      await runCli(
        ['observe', '--kind', 'latent-bug', '--files', 'a.ts,b.ts', 'races', 'under', 'load'],
        d,
      ),
    ).toBe(0)
    expect(d.out).toEqual(['observation recorded: obs_1'])
    const events = await store.getEvents(BUILD)
    const observation = events[events.length - 1]!
    expect(observation.type).toBe('observation.recorded')
    expect(observation.payload).toEqual({
      id: 'obs_1',
      kind: 'latent-bug',
      summary: 'races under load',
      files: ['a.ts', 'b.ts'],
    })
  })
})

describe('runCli — escalate and server', () => {
  test('escalate joins the positional question and passes refs', async () => {
    const d = makeDeps({ store, env: makeEnv({ phase: 'plan', round: 1 }) })
    expect(
      await runCli(['escalate', 'is', 'the', 'spec', 'right?', '--refs', 'spec@0'], d),
    ).toBe(0)
    expect(d.out).toEqual(['escalation raised: esc_1'])
    const events = await store.getEvents(BUILD)
    const raised = events[events.length - 1]!
    expect(raised.type).toBe('escalation.raised')
    expect(raised.payload).toEqual({
      id: 'esc_1',
      phase: 'plan',
      round: 1,
      source: 'agent',
      question: 'is the spec right?',
      refs: ['spec@0'],
    })
  })

  test('server status works without config and reports not running', async () => {
    const workspace = join(tmp, 'ws-server')
    await initWorkspaceRepo(workspace)
    const d = makeDeps({
      store,
      env: makeEnv({ phase: 'implement' }),
      workspacePath: workspace,
    })
    expect(await runCli(['server', 'status'], d)).toBe(0)
    expect(d.out).toEqual(['not running'])
  })

  test('server start in a phase without server access exits 1 with the policy error', async () => {
    const d = makeDeps({
      store,
      env: makeEnv({ phase: 'plan' }),
      workspacePath: join(tmp, 'nowhere'),
    })
    expect(await runCli(['server', 'start'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('not available in phase "plan"')
  })

  test('server with a bad subcommand prints usage and exits 1', async () => {
    const d = makeDeps({ store, env: makeEnv({ phase: 'implement' }), workspacePath: tmp })
    expect(await runCli(['server', 'reboot'], d)).toBe(1)
    expect(d.err.join('\n')).toContain('usage: ab server <start|stop|restart|status|logs>')
  })
})

describe('runCli — §8.7 walkthrough: the implementer session over fakes', () => {
  test('context → (work, commit) → observe → done, asserting the final event sequence', async () => {
    const workspace = join(tmp, 'ws-walk')
    await initWorkspaceRepo(workspace)
    await store.append(BUILD, {
      actor: KERNEL,
      type: 'implement.started',
      payload: { round: 1 },
    })
    const d = makeDeps({
      store,
      env: makeEnv({ phase: 'implement', round: 1 }),
      workspacePath: workspace,
    })

    // ab context — hydrates .ab/ with the phase's inputs.
    expect(await runCli(['context'], d)).toBe(0)
    expect(existsSync(join(workspace, '.ab', 'spec.md'))).toBe(true)

    // (work, commit) — .ab/ is gitignored, so notes there keep the tree clean.
    const head = await commitFile(workspace, 'limiter.ts', 'export {}\n', 'add limiter')
    const base = await runGit(['rev-parse', 'main'], workspace)
    await writeFile(join(workspace, '.ab', 'implement-notes.md'), 'added the limiter\n')

    // ab observe — structured, mid-phase, not a terminal.
    expect(
      await runCli(['observe', '--kind', 'refactor', 'auth', 'module', 'needs', 'splitting'], d),
    ).toBe(0)

    // ab done — validates clean worktree, pushes the branch, emits the event.
    expect(
      await runCli(['done', '--notes', join(workspace, '.ab', 'implement-notes.md')], d),
    ).toBe(0)
    expect(d.out[d.out.length - 1]).toMatch(/implement\.completed recorded \(seq \d+\)/)

    // The final event sequence, exactly (§8.7).
    const events = await store.getEvents(BUILD)
    expect(events.map((event) => event.type)).toEqual([
      'build.created',
      'spec.imported',
      'implement.started',
      'observation.recorded',
      'implement.completed',
    ])
    const completed = events[events.length - 1]!
    expect(completed.payload).toEqual({
      round: 1,
      commits: { base, head },
      artifact: { kind: 'implement-notes', rev: 0 },
    })
    // D7: the push happened kernel-side, triggered by the terminal.
    expect(d.forge.pushes).toEqual([{ workspacePath: workspace, branch: BRANCH }])
  })
})
