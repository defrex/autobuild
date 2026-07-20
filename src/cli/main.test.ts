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
import { KERNEL, agentActor } from '../events/envelope'
import { openLocalStore } from '../store/local/store'
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

  test('help documents every source-agnostic ticket operation', async () => {
    const d = deps()
    expect(await runCli(['help'], d)).toBe(0)
    const help = d.out.join('\n')
    for (const form of [
      'ab ticket create <title> --body <file> [--labels a,b] [--blocked-by id,id]',
      'ab ticket list [--state <state>] [--labels a,b] [--json]',
      'ab ticket show <id> [--json]',
      'ab ticket move <id> <state> [--json]',
    ]) {
      expect(help).toContain(form)
    }
    expect(help).toContain('same ready criteria as dispatch')
    expect(help).toContain('show one ticket, including its body/spec')
  })

  test('help documents status and every sessionless build-control command', async () => {
    const d = deps()
    expect(await runCli(['help'], d)).toBe(0)
    const help = d.out.join('\n')
    expect(help).toContain('ab builds [--queued] [--all] [--json] [--store <ref>]')
    expect(help).toContain('ab build status <slug> [--events <n>] [--json] [--store <ref>]')
    expect(help).toContain('running, paused, blocked')
    for (const command of [
      'ab pause <slug>',
      'ab resume <slug>',
      'ab auto-merge <slug> <on|off>',
      'ab answer <slug>',
      'ab abort <slug>',
    ]) {
      expect(help).toContain(command)
    }
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
    expect(d.err.join('\n')).toContain('usage: ab verdict <approve|revise|escalate|pass|fail|skip>')
  })
})

describe('SESSIONLESS_COMMANDS', () => {
  // bin/ab.ts routes on this set; a command missing from it goes through
  // resolveCliEnv and exits 1 on absent AB_* before routing. runCli tests
  // cannot see that failure — they never traverse the binary — so the set
  // itself is asserted here, and the binary is smoke-tested in bin-ab.test.ts.
  test('contains the status and build-control commands', () => {
    for (const command of [
      'builds',
      'build',
      'pause',
      'resume',
      'auto-merge',
      'answer',
      'abort',
    ]) {
      expect(SESSIONLESS_COMMANDS.has(command)).toBe(true)
    }
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
  test('sessionless and ticket-only flags did not leak into phase commands', async () => {
    const cases: Array<{ argv: string[]; flag: string }> = [
      { argv: ['done', '--store', '/tmp/x'], flag: '--store' },
      {
        argv: ['observe', '--kind', 'followup', '--events', '3', 'x'],
        flag: '--events',
      },
      { argv: ['done', '--state', 'Ready'], flag: '--state' },
      { argv: ['done', '--labels', 'api'], flag: '--labels' },
      { argv: ['done', '--body', 'spec.md'], flag: '--body' },
    ]
    for (const { argv, flag } of cases) {
      const d = deps()
      expect(await runCli(argv, d)).toBe(1)
      expect(d.err.join('\n')).toContain(`unknown flag ${flag}`)
    }
  })
})

describe('runCli — sessionless build controls', () => {
  const slug = 'control-build'

  async function seedControlStore(
    storeRef: string,
    opts: { escalations?: string[]; queuedSlug?: string } = {},
  ): Promise<void> {
    const local = openLocalStore(storeRef)
    await local.createBuild({ slug, repo: tmp })
    await local.append(slug, {
      actor: KERNEL,
      type: 'runner.attached',
      payload: { instance: 'runner-1', host: 'host-1', resumedFromSeq: 0 },
    })
    for (const id of opts.escalations ?? []) {
      await local.append(slug, {
        actor: agentActor('implement', `session-${id}`),
        type: 'escalation.raised',
        payload: {
          id,
          phase: 'implement',
          round: 1,
          source: 'agent',
          question: `Question ${id}?`,
        },
      })
    }
    if (opts.queuedSlug !== undefined) {
      await local.createBuild({ slug: opts.queuedSlug, repo: tmp })
    }
    await local.close()
  }

  function controlDeps(
    storeRef: string,
    env: Record<string, string | undefined> = {},
  ) {
    const out: string[] = []
    const err: string[] = []
    return {
      workspacePath: tmp,
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      exec: async () => ({ stdout: '', stderr: 'not a git repo', exitCode: 128 }),
      processEnv: { AB_STORE: storeRef, USER: 'cli-op', ...env },
      out,
      err,
    }
  }

  test('routes every explicit command to its durable event and joins answer text', async () => {
    const storeRef = join(tmp, 'controls-store')
    await seedControlStore(storeRef, { escalations: ['esc-1', 'esc-2'] })
    const invocations = [
      ['pause', slug],
      ['resume', slug],
      ['auto-merge', slug, 'on'],
      ['auto-merge', slug, 'off'],
      ['abort', slug],
      ['answer', slug, 'Use', 'the', 'safe', 'path.'],
    ]
    for (const argv of invocations) {
      const d = controlDeps(storeRef)
      expect(await runCli(argv, d)).toBe(0)
      expect(d.err).toEqual([])
      expect(d.out).toHaveLength(1)
    }

    const local = openLocalStore(storeRef)
    const events = await local.getEvents(slug)
    expect(events.slice(-7).map((event) => event.type)).toEqual([
      'build.pause-requested',
      'build.resume-requested',
      'build.auto-merge-requested',
      'build.auto-merge-cancelled',
      'build.abort-requested',
      'escalation.answered',
      'escalation.answered',
    ])
    const answers = events.filter((event) => event.type === 'escalation.answered')
    expect(answers.map((event) => event.payload.answer)).toEqual([
      'Use the safe path.',
      'Use the safe path.',
    ])
    expect(
      events.slice(-7).every(
        (event) => event.actor.kind === 'human' && event.actor.user === 'cli-op',
      ),
    ).toBe(true)
    await local.close()
  })

  test('answer with no text selects retry', async () => {
    const storeRef = join(tmp, 'retry-store')
    await seedControlStore(storeRef, { escalations: ['esc-retry'] })
    const d = controlDeps(storeRef)
    expect(await runCli(['answer', slug], d)).toBe(0)

    const local = openLocalStore(storeRef)
    const event = (await local.getEvents(slug)).at(-1)
    expect(event?.type).toBe('escalation.answered')
    if (event?.type === 'escalation.answered') {
      expect(event.payload.resolution).toBe('retry')
      expect(event.payload.answer).toContain('no feedback')
    }
    await local.close()
  })

  test('every verb refuses an own-phase target before appending', async () => {
    const storeRef = join(tmp, 'self-store')
    await seedControlStore(storeRef, { escalations: ['esc-self'] })
    const attempts = [
      ['pause', slug],
      ['resume', slug],
      ['auto-merge', slug, 'on'],
      ['auto-merge', slug, 'off'],
      ['answer', slug, 'retry please'],
      ['abort', slug],
    ]
    for (const argv of attempts) {
      const d = controlDeps(storeRef, {
        AB_SESSION: 'phase-session',
        AB_BUILD: slug,
      })
      expect(await runCli(argv, d)).toBe(1)
      expect(d.err.join('\n')).toContain('own phase session')
      expect(d.err.join('\n')).toContain('AB_SESSION/AB_BUILD conflict')
    }

    const local = openLocalStore(storeRef)
    expect(await local.getEvents(slug)).toHaveLength(2)
    await local.close()
  })

  test('a phase session may control a different build', async () => {
    const storeRef = join(tmp, 'other-build-store')
    await seedControlStore(storeRef)
    const d = controlDeps(storeRef, {
      AB_SESSION: 'phase-session',
      AB_BUILD: 'another-build',
    })
    expect(await runCli(['pause', slug], d)).toBe(0)

    const local = openLocalStore(storeRef)
    expect((await local.getEvents(slug)).at(-1)?.type).toBe(
      'build.pause-requested',
    )
    await local.close()
  })

  test('rejects missing, inactive, and unblocked targets with named conflicts', async () => {
    const storeRef = join(tmp, 'precondition-store')
    await seedControlStore(storeRef, { queuedSlug: 'queued-build' })

    const missing = controlDeps(storeRef)
    expect(await runCli(['abort', 'missing-build'], missing)).toBe(1)
    expect(missing.err.join('\n')).toContain('no build "missing-build"')

    const inactive = controlDeps(storeRef)
    expect(await runCli(['pause', 'queued-build'], inactive)).toBe(1)
    expect(inactive.err.join('\n')).toContain('not active (status: queued)')

    const unblocked = controlDeps(storeRef)
    expect(await runCli(['answer', slug, 'guidance'], unblocked)).toBe(1)
    expect(unblocked.err.join('\n')).toContain('no open escalations')
  })

  test('--store overrides AB_STORE for every control shell', async () => {
    const explicit = join(tmp, 'explicit-controls')
    await seedControlStore(explicit)
    const d = controlDeps(join(tmp, 'wrong-store'))
    expect(
      await runCli(['pause', slug, '--store', explicit], d),
    ).toBe(0)

    const local = openLocalStore(explicit)
    expect((await local.getEvents(slug)).at(-1)?.type).toBe(
      'build.pause-requested',
    )
    await local.close()
  })

  test('command grammars reject missing values, extras, bad settings, and flags', async () => {
    const cases = [
      ['pause'],
      ['pause', slug, 'extra'],
      ['resume', slug, '--unknown'],
      ['auto-merge', slug],
      ['auto-merge', slug, 'maybe'],
      ['answer'],
      ['answer', slug, '--unknown'],
      ['abort', slug, '--store', '--unknown'],
    ]
    for (const argv of cases) {
      const d = controlDeps(join(tmp, 'grammar-store'))
      expect(await runCli(argv, d)).toBe(1)
      expect(d.err.join('\n')).toContain('usage: ab')
      expect(d.out).toEqual([])
    }
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

describe('runCli — ab dispatch flag parsing (§3.3)', () => {
  // `dispatch` routes before any store/env requirement and does its own heavy
  // wiring, so malformed argv must stop before config/store access. Valid argv
  // reaches the real one-shot dispatcher over an empty file-ticket repo.
  async function writeDispatchConfig(): Promise<void> {
    await writeFile(
      join(tmp, 'autobuild.toml'),
      '[tickets]\nsource = "file"\nreadyState = "ready"\ndir = "tickets"\n',
    )
  }

  test('--plain parses', async () => {
    const d = deps()
    expect(await runCli(['dispatch', '--once', '--plain'], { ...d, workspacePath: tmp })).toBe(1)
    expect(d.err.join('\n')).toContain('autobuild.toml: not found')
    expect(d.err.join('\n')).not.toContain('unknown argument')
  })

  test('--store with no value is the same usage error as other sessionless commands', async () => {
    const d = deps()
    expect(await runCli(['dispatch', '--store'], { ...d, workspacePath: tmp })).toBe(1)
    const err = d.err.join('\n')
    expect(err).toContain('--store requires a value')
    expect(err).toContain('usage: ab dispatch')
    expect(d.out).toEqual([])
  })

  test('--store followed by --once rejects before dispatch or state access', async () => {
    await writeDispatchConfig()
    const d = deps()
    const stop = new AbortController()
    stop.abort()

    expect(
      await runCli(['dispatch', '--store', '--once'], {
        ...d,
        workspacePath: tmp,
        signal: stop.signal,
      }),
    ).toBe(1)
    const err = d.err.join('\n')
    expect(err).toContain('--store requires a value')
    expect(err).toContain('--once')
    expect(err).toContain('usage: ab dispatch')
    expect(d.out).toEqual([])
    expect(existsSync(join(tmp, '--once'))).toBe(false)
  })

  test('a valid --store value preserves one-shot dispatch flag ordering', async () => {
    await writeDispatchConfig()
    const cases = [
      ['--store', join(tmp, 'store-first'), '--once', '--plain', '--interval', '0.001'],
      ['--once', '--plain', '--interval', '0.001', '--store', join(tmp, 'store-last')],
      ['--interval', '0.001', '--store', join(tmp, 'store-middle'), '--plain', '--once'],
    ]

    for (const args of cases) {
      const d = deps()
      expect(await runCli(['dispatch', ...args], { ...d, workspacePath: tmp })).toBe(0)
      expect(d.err).toEqual([])
      expect(d.out.join('\n')).toContain('ab dispatch — one pass')
      expect(d.out.join('\n')).toContain('tick: idle')
      const storeRef = args[args.indexOf('--store') + 1]!
      expect(existsSync(join(storeRef, 'autobuild.sqlite'))).toBe(true)
    }
  })

  test('both forms of each process-local launch setting parse', async () => {
    for (const flag of [
      '--intake',
      '--no-intake',
      '--auto-merge',
      '--no-auto-merge',
    ]) {
      const d = deps()
      expect(
        await runCli(['dispatch', '--once', flag], { ...d, workspacePath: tmp }),
      ).toBe(1)
      expect(d.err.join('\n')).toContain('autobuild.toml: not found')
      expect(d.err.join('\n')).not.toContain('unknown argument')
    }
  })

  test('--intake and --no-intake together are a usage error in either order', async () => {
    for (const flags of [
      ['--intake', '--no-intake'],
      ['--no-intake', '--intake'],
    ]) {
      const d = deps()
      expect(
        await runCli(['dispatch', ...flags], { ...d, workspacePath: tmp }),
      ).toBe(1)
      const err = d.err.join('\n')
      expect(err).toContain('--intake and --no-intake cannot be combined')
      expect(err).toContain('usage: ab dispatch')
    }
  })

  test('--auto-merge and --no-auto-merge together are a usage error in either order', async () => {
    for (const flags of [
      ['--auto-merge', '--no-auto-merge'],
      ['--no-auto-merge', '--auto-merge'],
    ]) {
      const d = deps()
      expect(
        await runCli(['dispatch', ...flags], { ...d, workspacePath: tmp }),
      ).toBe(1)
      const err = d.err.join('\n')
      expect(err).toContain(
        '--auto-merge and --no-auto-merge cannot be combined',
      )
      expect(err).toContain('usage: ab dispatch')
    }
  })

  test('the intake and auto-merge flag pairs are independent', async () => {
    const d = deps()
    expect(
      await runCli(
        ['dispatch', '--once', '--no-intake', '--auto-merge'],
        { ...d, workspacePath: tmp },
      ),
    ).toBe(1)
    expect(d.err.join('\n')).toContain('autobuild.toml: not found')
    expect(d.err.join('\n')).not.toContain('cannot be combined')
  })

  test('an unknown dispatch flag still errors with the usage string', async () => {
    const d = deps()
    expect(await runCli(['dispatch', '--dashboard'], { ...d, workspacePath: tmp })).toBe(1)
    const err = d.err.join('\n')
    expect(err).toContain('unknown argument "--dashboard"')
    expect(err).toContain('[--plain]')
    expect(err).toContain('[--intake | --no-intake]')
    expect(err).toContain('[--auto-merge | --no-auto-merge]')
  })

  test('the help advertises both process-local launch settings', async () => {
    const d = deps()
    await runCli(['help'], d)
    const help = d.out.join('\n')
    expect(help).toContain(
      'ab dispatch [--once] [--interval <s>] [--store <ref>] [--plain] [--intake | --no-intake] [--auto-merge | --no-auto-merge]',
    )
    expect(help).toContain('newly claimed builds only (default off)')
  })
})
