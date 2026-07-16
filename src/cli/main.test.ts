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
import { runCli } from './main'
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
