import { describe, expect, test } from 'bun:test'
import { parseConfig } from '../config/load'
import type { Config } from '../config/schema'
import type { AbEvent } from '../events/catalog'
import { DISPATCHER } from '../events/envelope'
import { sequentialIds } from '../ids'
import { integrationConfig } from '../kernel/integration-state'
import { FakeForge } from '../ports/forge/fake'
import { defaultTurnResult } from '../ports/runner/fake'
import type { AgentRunner } from '../ports/types'
import type { Exec, ExecResult } from '../ports/workspace/git-worktree'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import { BuildRunner, type BuildRunnerOpts } from './build-runner'

// Polls the memory store's subscription and waits on in-flight work, so this
// is an integration test even though it touches no filesystem or Git.

const NODE = 'landed-node'
const PARENT = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

const CHECK_CONFIG = `
[tickets]
source = "file"
readyState = "ready"
[roles.default]
runtime = "stuck"
[commands]
test = "run-tests"
[verify]
steps = ["unit"]
[verify.unit]
kind = "check"
command = "test"
`

const AGENT_CONFIG = `
[tickets]
source = "file"
readyState = "ready"
[roles.default]
runtime = "stuck"
[verify]
steps = ["acceptance"]
[verify.acceptance]
kind = "agent"
skill = "verify-feature"
`

const STAGED_CONFIG = `
[tickets]
source = "file"
readyState = "ready"
[roles.default]
runtime = "stuck"
[commands]
test = "run-tests"
[verify]
steps = [["unit", "acceptance"]]
[verify.unit]
kind = "check"
command = "test"
[verify.acceptance]
kind = "agent"
skill = "verify-feature"
`

/** A verify command that runs until its signal aborts, or until released.
 * `shutdownMs` delays the aborted command's exit, like a process that takes
 * time to stop after its signal. */
function blockingExec(shutdownMs = 0) {
  let started = false
  let finished = false
  let signal: AbortSignal | undefined
  let release!: (result: ExecResult) => void
  const exec: Exec = async (cmd, opts) => {
    if (cmd[0] === 'git' && cmd[1] === 'rev-parse' && cmd.includes('HEAD'))
      return { stdout: `${HEAD}\n`, stderr: '', exitCode: 0 }
    if (cmd[0] === 'sh') {
      started = true
      signal = opts?.signal
      return new Promise<ExecResult>((resolve) => {
        release = resolve
        signal?.addEventListener('abort', () => {
          const exit = () => {
            finished = true
            resolve({ stdout: '', stderr: 'killed', exitCode: 143 })
          }
          if (shutdownMs === 0) exit()
          else setTimeout(exit, shutdownMs)
        })
      })
    }
    return { stdout: '', stderr: '', exitCode: 0 }
  }
  return {
    exec,
    started: () => started,
    finished: () => finished,
    signal: () => signal,
    release: (result: ExecResult) => release(result),
  }
}

/** An agent that works until its turn is cancelled, then returns its handle. */
function stuckAgent() {
  let signal: AbortSignal | undefined
  const ended: string[] = []
  const runner: AgentRunner = {
    name: 'stuck',
    start: (opts) => {
      signal = opts.signal
      return new Promise((resolve) => {
        const settle = () =>
          resolve({ session: { id: 'native-1', runner: 'stuck' }, result: defaultTurnResult() })
        if (opts.signal?.aborted) settle()
        opts.signal?.addEventListener('abort', settle)
      })
    },
    continue: async () => defaultTurnResult(),
    end: async (session) => {
      ended.push(session.id)
      return {
        content: '',
        metadata: { runner: 'stuck', usage: { inputTokens: 0, outputTokens: 0, turns: 0 } },
      }
    },
  }
  return { runner, signal: () => signal, ended }
}

/** A complete node with a prepared, current verification cycle. */
async function preparedNode(config: Config) {
  const store = new MemoryBuildStore()
  await store.createBuild({ slug: NODE, repo: 'repo', branch: `ab-node/${NODE}` })
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
  await store.append(NODE, { actor: DISPATCHER, type: 'node.opened', payload: { sha: PARENT } })
  await store.append(NODE, {
    actor: DISPATCHER,
    type: 'node.compared',
    payload: { parentSha: PARENT, headSha: HEAD, ahead: 1 },
  })
  await store.append(NODE, {
    actor: DISPATCHER,
    type: 'integration.observed',
    payload: { openChildren: [], diagnostics: [], contributions: ['child'] },
  })
  await store.append(NODE, {
    actor: DISPATCHER,
    type: 'integration.prepared',
    payload: { id: 'cycle-1', parent: PARENT, head: HEAD, config: integrationConfig(config) },
  })
  return store
}

function runnerFor(
  store: MemoryBuildStore,
  config: Config,
  exec: Exec,
  agent: AgentRunner,
  scheduleHeartbeat: NonNullable<BuildRunnerOpts['scheduleHeartbeat']>,
) {
  return new BuildRunner({
    store: store.scopeBuild(NODE),
    config,
    runtimes: { stuck: { runner: agent, servesModels: [''] } },
    workspacePath: '/ws',
    branch: `ab-node/${NODE}`,
    slug: NODE,
    exec,
    timeoutSignal: () => new AbortController().signal,
    forge: new FakeForge(),
    ids: sequentialIds(),
    clock: steppingClock(),
    instance: 'runner-1',
    host: 'test',
    runtimeIdentity: {
      version: '0.0.0-test',
      commit: 'unknown',
      source: { kind: 'package', location: '/autobuild' },
    },
    opts: { scheduleHeartbeat },
  })
}

/** Captures the heartbeat so the test fires beats explicitly. */
function manualHeartbeat() {
  let beat: (() => void) | undefined
  const schedule: NonNullable<BuildRunnerOpts['scheduleHeartbeat']> = (fn) => {
    beat = fn
    return () => {
      beat = undefined
    }
  }
  return {
    schedule,
    beat: () => {
      if (!beat) throw new Error('heartbeat not armed')
      beat()
    },
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let spin = 0; spin < 2000; spin += 1) {
    if (condition()) return
    await Bun.sleep(1)
  }
  throw new Error(`timed out waiting for ${what}`)
}

const landing = {
  actor: DISPATCHER,
  type: 'integration.landed' as const,
  payload: {
    head: HEAD,
    landed: HEAD,
    provenance: 'human' as const,
    verified: false,
    fenced: false,
  },
}

const types = (events: AbEvent[]) => events.map((event) => event.type)

describe('a node landing ends its open verification', () => {
  test('a sequential check stops at the next lapsed beat after the dispatcher withdraws the lease', async () => {
    const config = parseConfig(CHECK_CONFIG)
    const store = await preparedNode(config)
    const command = blockingExec()
    const heartbeat = manualHeartbeat()
    const runner = runnerFor(store, config, command.exec, stuckAgent().runner, heartbeat.schedule)
    const running = runner.run()
    await until(command.started, 'the verify command')
    await store.releaseLease(NODE, 'runner-1')
    await store.append(NODE, landing)
    heartbeat.beat()
    await until(() => command.signal()?.aborted === true, 'the command to abort')
    const state = await running
    expect(state.integration?.landing).toBeDefined()
    const events = await store.getEvents(NODE)
    expect(types(events)).toContain('verify.started')
    expect(types(events)).not.toContain('verify.completed')
    expect(types(events)).not.toContain('phase.failed')
  })

  test('a lapse without a landing leaves the running check alone', async () => {
    const config = parseConfig(CHECK_CONFIG)
    const store = await preparedNode(config)
    const command = blockingExec()
    const heartbeat = manualHeartbeat()
    const runner = runnerFor(store, config, command.exec, stuckAgent().runner, heartbeat.schedule)
    const running = runner.run()
    await until(command.started, 'the verify command')
    await store.releaseLease(NODE, 'runner-1')
    heartbeat.beat()
    // Let the lapsed beat and any read it might trigger settle.
    await Bun.sleep(20)
    expect(command.signal()?.aborted ?? false).toBe(false)
    command.release({ stdout: 'ok', stderr: '', exitCode: 0 })
    await running
    const completed = (await store.getEvents(NODE)).filter(
      (event) => event.type === 'verify.completed',
    )
    expect(completed.map((event) => event.payload)).toEqual([
      expect.objectContaining({ step: 'unit', outcome: 'pass' }),
    ])
  })

  test('an agent verification session ends as an operator stop when the node lands', async () => {
    const config = parseConfig(AGENT_CONFIG)
    const store = await preparedNode(config)
    const agent = stuckAgent()
    const heartbeat = manualHeartbeat()
    const runner = runnerFor(store, config, blockingExec().exec, agent.runner, heartbeat.schedule)
    const running = runner.run()
    await until(() => agent.signal() !== undefined, 'the verification session')
    await store.append(NODE, landing)
    const state = await running
    expect(agent.signal()?.aborted).toBe(true)
    expect(agent.ended).toEqual(['native-1'])
    expect(state.sessions.open).toEqual([])
    const events = await store.getEvents(NODE)
    expect(types(events)).toContain('session.ended')
    expect(types(events)).not.toContain('verify.completed')
    expect(types(events)).not.toContain('phase.failed')
    expect(types(events)).not.toContain('session.suspended')
  })

  test('a staged check and agent both end, with no suspended session, when the node lands', async () => {
    const config = parseConfig(STAGED_CONFIG)
    const store = await preparedNode(config)
    const command = blockingExec()
    const agent = stuckAgent()
    const heartbeat = manualHeartbeat()
    const runner = runnerFor(store, config, command.exec, agent.runner, heartbeat.schedule)
    const running = runner.run()
    await until(
      () => command.started() && agent.signal() !== undefined,
      'both stage members to start',
    )
    await store.append(NODE, landing)
    const state = await running
    expect(command.signal()?.aborted).toBe(true)
    expect(agent.ended).toEqual(['native-1'])
    expect(state.sessions.open).toEqual([])
    const events = await store.getEvents(NODE)
    expect(types(events)).not.toContain('verify.completed')
    expect(types(events)).not.toContain('phase.failed')
    expect(types(events)).not.toContain('session.suspended')
  })

  test('a landing keeps the stage open until a slow-stopping check has exited', async () => {
    const config = parseConfig(STAGED_CONFIG)
    const store = await preparedNode(config)
    const command = blockingExec(50)
    const agent = stuckAgent()
    const heartbeat = manualHeartbeat()
    const runner = runnerFor(store, config, command.exec, agent.runner, heartbeat.schedule)
    const running = runner.run()
    await until(
      () => command.started() && agent.signal() !== undefined,
      'both stage members to start',
    )
    await store.append(NODE, landing)
    await until(() => command.signal()?.aborted === true, 'the check to be aborted')
    expect(command.finished()).toBe(false)
    await running
    expect(command.finished()).toBe(true)
    const events = await store.getEvents(NODE)
    expect(types(events)).not.toContain('verify.completed')
    expect(types(events)).not.toContain('session.suspended')
  })
})
