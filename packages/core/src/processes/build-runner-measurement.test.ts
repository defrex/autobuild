// Load the reducer registry first: build-runner's import cycle otherwise reaches
// a reducer before it is initialized when this file runs alone.
import '../kernel/reducer-registry'
import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER, humanActor } from '../events/envelope'
import { sequentialIds } from '../ids'
import type { Decision } from '../kernel/engine'
import type { Objective } from '../objective'
import { FakeForge } from '../ports/forge/fake'
import { ScriptedAgentRunner } from '../ports/runner/fake'
import type { Exec, ExecResult } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { reduceBuild } from '../kernel/reducer'
import { steppingClock } from '../testing/fixed'
import { BuildRunner } from './build-runner'

const PIN = 'a'.repeat(40)
const NEW_PIN = 'b'.repeat(40)
const NODE = 'opt-node'
const ATTEMPT = 'attempt-a1'

function objective(overrides: { epsilon?: Objective['target']['epsilon']; command?: string } = {}) {
  return {
    purpose: 'faster search',
    metric: {
      kind: 'command' as const,
      command: overrides.command ?? 'bench',
      direction: 'minimize' as const,
      samples: 1,
      harness: ['bench/**'],
    },
    target: { epsilon: overrides.epsilon ?? { absolute: 1 } },
    budget: { maxAttempts: 5 },
    stop: { mode: 'abort' as const },
    proposer: { concurrency: 1 },
  } satisfies Objective
}

/** Scripted Git plumbing; each metric run answers with the next value for its
 * side and may first run a hook that mutates the store mid-measurement. */
function scriptedExec(
  values: Record<'baseline' | 'candidate', number[]>,
  hook?: (run: number) => Promise<void>,
  fail?: ExecResult,
): Exec {
  let runs = 0
  return async (cmd, { cwd }) => {
    if (cmd[0] === 'git' && cmd[1] === 'rev-parse')
      return { stdout: '/ws/.git\n', stderr: '', exitCode: 0 }
    if (cmd[0] === 'sh') {
      runs += 1
      await hook?.(runs)
      if (fail) return fail
      const side = cwd!.endsWith('/candidate') ? 'candidate' : 'baseline'
      return { stdout: JSON.stringify({ value: values[side].shift() }), stderr: '', exitCode: 0 }
    }
    return { stdout: '', stderr: '', exitCode: 0 }
  }
}

async function fixture(exec: Exec, slug: string) {
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
  await store.createBuild({ slug: ATTEMPT, repo: 'repo', branch: `ab/${ATTEMPT}` })
  await store.append(ATTEMPT, {
    actor: DISPATCHER,
    type: 'build.created',
    payload: { ticket: { source: 'file', id: 'T-a1' }, repo: 'repo', baseBranch: `ab/${NODE}` },
  })
  const config = parseConfig(
    '[tickets]\nsource = "file"\nreadyState = "ready"\n\n[roles.default]\nruntime = "scripted"\n',
  )
  const runner = new BuildRunner({
    store: store.scopeBuild(slug),
    config,
    runtimes: { scripted: { runner: new ScriptedAgentRunner({ script: {} }) } },
    workspacePath: '/ws',
    branch: `ab/${slug}`,
    slug,
    exec,
    timeoutSignal: () => new AbortController().signal,
    forge: new FakeForge(),
    ids: sequentialIds(),
    clock: steppingClock(),
    instance: 'runner-1',
    host: 'test',
  })
  const internals = runner as unknown as {
    measureBaseline(decision: Extract<Decision, { kind: 'measure-baseline' }>): Promise<void>
    runMeasurement(decision: Extract<Decision, { kind: 'run-measurement' }>): Promise<void>
  }
  return { store, runner, internals }
}

const types = (events: AbEvent[]) => events.map((event) => event.type)

describe('the node starting measurement', () => {
  test('records the median and spread with the raw samples', async () => {
    const { store, internals } = await fixture(
      scriptedExec({ baseline: [10], candidate: [10.4] }),
      NODE,
    )
    await internals.measureBaseline({ kind: 'measure-baseline', revision: 1, harnessPin: PIN })
    const events = await store.getEvents(NODE)
    const measured = events.at(-1) as AbEvent & { type: 'optimization.baseline-measured' }
    expect(measured.type).toBe('optimization.baseline-measured')
    expect(measured.payload).toMatchObject({
      revision: 1,
      head: PIN,
      harnessPin: PIN,
      samples: 1,
      median: 10.2,
      report: { kind: 'measurement-samples', rev: 0 },
    })
    expect(measured.payload.spread).toBeCloseTo(0.4)
    expect(types(events)).not.toContain('optimization.noise-exceeded')
    const report = await store.getArtifact(NODE, 'measurement-samples', 0)
    expect(JSON.parse(new TextDecoder().decode(report!.content))).toMatchObject({
      baseline: [10],
      candidate: [10.4],
    })
  })

  test('a zero median with a relative epsilon raises the noise check first, and still opens', async () => {
    const { store, internals } = await fixture(
      scriptedExec({ baseline: [-1], candidate: [1] }),
      NODE,
    )
    await store.append(NODE, {
      actor: humanActor('ada'),
      type: 'optimization.objective-revised',
      payload: { changes: { epsilon: { relative: 0.05 } }, revision: 2 },
    })
    await internals.measureBaseline({ kind: 'measure-baseline', revision: 2, harnessPin: PIN })
    const events = await store.getEvents(NODE)
    expect(types(events).slice(-2)).toEqual([
      'optimization.noise-exceeded',
      'optimization.baseline-measured',
    ])
    expect(events.at(-2)!.payload).toEqual({
      revision: 2,
      head: PIN,
      harnessPin: PIN,
      median: 0,
      spread: 2,
      epsilon: { relative: 0.05 },
      effectiveEpsilon: 0,
    })
    const state = reduceBuild(await store.getEvents(NODE))
    expect(state.optimization?.starting).toEqual({ value: 0, spread: 2, head: PIN })
    expect(state.status).not.toBe('blocked')
  })

  test('a failing command escalates instead of recording a value; an answer re-arms it', async () => {
    const { store, runner } = await fixture(
      scriptedExec({ baseline: [], candidate: [] }, undefined, {
        stdout: '',
        stderr: 'bench: not found',
        exitCode: 127,
      }),
      NODE,
    )
    expect(await runner.step()).toEqual({ kind: 'measure-baseline', revision: 1, harnessPin: PIN })
    const raised = (await store.getEvents(NODE)).at(-1) as AbEvent & {
      type: 'escalation.raised'
    }
    expect(raised.payload).toMatchObject({
      phase: 'measurement',
      source: 'policy',
      policyCause: 'measurement-failed',
    })
    expect(raised.payload.question).toContain('exited 127 (baseline sample 1/1)')
    expect(raised.payload.question).toContain('bench: not found')
    expect(await runner.step()).toEqual({ kind: 'wait', reason: 'blocked' })
    await store.append(NODE, {
      actor: humanActor('ada'),
      type: 'escalation.answered',
      payload: { id: raised.payload.id, answer: 'retry', resolution: 'guidance' },
    })
    expect((await runner.step()).kind).toBe('measure-baseline')
  })

  test('a new ruler during sampling discards the samples', async () => {
    let store!: MemoryBuildStore
    const exec = scriptedExec({ baseline: [10], candidate: [10] }, async (run) => {
      if (run === 1)
        await store.append(NODE, {
          actor: DISPATCHER,
          type: 'optimization.objective-accepted',
          payload: {
            objective: objective({ command: 'bench --v2' }),
            revision: 2,
            harnessPin: NEW_PIN,
            specRev: 1,
          },
        })
    })
    const built = await fixture(exec, NODE)
    store = built.store
    await built.internals.measureBaseline({
      kind: 'measure-baseline',
      revision: 1,
      harnessPin: PIN,
    })
    expect(types(await store.getEvents(NODE))).not.toContain('optimization.baseline-measured')
    expect(reduceBuild(await store.getEvents(NODE)).optimization?.accepted.harnessPin).toBe(NEW_PIN)
  })
})
