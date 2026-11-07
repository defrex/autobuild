// AUT-1017: a hosted harvest guest outlives the cron invocation that launched
// it. Later invocations must leave its open session alone while the provider
// reports the execution running, and judge runner loss exactly once after
// settlement proves the execution gone.

import { expect, test } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { abDispatch, type TimerScheduler } from '../cli/dispatch'
import { resolveHarvestCliEnv } from '../cli/env'
import { runCli } from '../cli/main'
import { DISPATCHER, agentActor } from '../events/envelope'
import type { RepositoryEvent } from '../events/repository'
import { randomUuids } from '../ids'
import { reduceHarvest } from '../kernel/harvest'
import type { WorkspaceHandle } from '../ports/types'
import { defaultTurnResult, ScriptedAgentRunner } from '../ports/runner/fake'
import type { ExecutionObservation } from '../ports/workspace/build-execution'
import { spawnExec } from '../ports/workspace/git-worktree'
import type {
  BuildExecutionHandle,
  HarvestExecution,
  HarvestExecutionStart,
} from '../ports/workspace/harvest-execution'
import { HarvestRunner } from '../processes/harvest-runner'
import { CONFIG_TOML, makeHarness, type E2eHarness } from './harness'

const LOSS = 'harvest agent interrupted by runner loss'

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const until = async (check: () => Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 1_000; i += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** A hosted-style fixture: the harness wiring plus a provider
 * `harvestExecution` whose first start runs a real in-process HarvestRunner
 * guest that keeps working after its launching invocation detaches. */
async function hostedFixture() {
  const h = await makeHarness({
    handlers: {},
    tickets: [],
    configToml: CONFIG_TOML.replace('stallRounds = 3', 'stallRounds = 3\nharvestThreshold = 1'),
  })
  const synthesizeGate = deferred()
  const harvestAgents = new ScriptedAgentRunner({
    script: async (ctx) => {
      const harvestEnv = resolveHarvestCliEnv(ctx.opts.env)
      const run = async (argv: string[]): Promise<void> => {
        const err: string[] = []
        const code = await runCli(argv, {
          store: h.store,
          harvestEnv,
          workspacePath: h.origin,
          ids: h.ids,
          stdout: () => {},
          stderr: (line) => err.push(line),
        })
        if (code !== 0) {
          const message = `ab ${argv.join(' ')} exited ${code}: ${err.join('\n')}`
          h.cliErrors.push(message)
          throw new Error(message)
        }
      }
      await run(['harvest', 'context'])
      if (ctx.opts.skill === 'ab-harvest') {
        // The session stays open across dispatcher invocations until released.
        await synthesizeGate.promise
        const observations = JSON.parse(
          await readFile(join(h.origin, '.ab', 'observations.json'), 'utf8'),
        ) as Array<{ occurrence: { build: string; seq: number } }>
        const file = join(h.origin, '.ab', `proposals-${harvestEnv.run}.json`)
        await writeFile(
          file,
          JSON.stringify({
            proposals: [
              {
                action: 'create',
                title: 'Harvest the hosted defect',
                whatWhy: 'The observation exposes one actionable defect.',
                acceptanceCriteria: ['The defect no longer occurs.'],
                outOfScope: ['Unrelated cleanup.'],
                observations: observations.map((item) => item.occurrence),
              },
            ],
          }),
        )
        await run(['harvest', 'submit', file])
      } else {
        const notes = join(h.origin, '.ab', 'review.md')
        await writeFile(notes, 'approved\n')
        await run(['harvest', 'verdict', 'approve', '--notes', notes])
      }
      return defaultTurnResult('harvest CLI terminal deposited')
    },
  })

  let observation: ExecutionObservation = { state: 'running' }
  const observed: string[] = []
  const starts: HarvestExecutionStart[] = []
  const reaps: WorkspaceHandle[] = []
  let guest: Promise<unknown> | undefined
  const execution: HarvestExecution = {
    start: async (input) => {
      starts.push(input)
      const completion = deferred<{ exitCode: number }>()
      if (starts.length === 1) {
        guest = new HarvestRunner({
          store: h.store,
          tickets: h.tickets,
          config: h.config,
          runtimes: { scripted: { runner: harvestAgents, servesModels: [] } },
          repo: input.repo,
          workspacePath: h.origin,
          ids: h.ids,
          uuids: randomUuids(),
          clock: h.clock,
          instance: input.instance,
          ...(input.leaseHolder !== undefined ? { leaseHolder: input.leaseHolder } : {}),
          ...(input.preparedRun !== undefined ? { preparedRun: input.preparedRun } : {}),
          sessionEnv: { AB_STORE: 'memory' },
          opts: { heartbeatMs: 3_600_000, leaseTtlMs: 3_600_000 },
        })
          .run()
          .finally(() => completion.resolve({ exitCode: 0 }))
      } else {
        // A recovery launch whose guest exits at once without work.
        completion.resolve({ exitCode: 0 })
      }
      const environmentId = `harvest-env-${starts.length}`
      const handle: BuildExecutionHandle = {
        supervision: 'environment',
        identity: {
          provider: h.workspaces.name,
          workspaceRef: environmentId,
          environmentId,
          commandId: `cmd-${starts.length}`,
        },
        completion: completion.promise,
        stop: async () => ({ outcome: 'confirmed' as const }),
        // Teardown hands the wait back while the guest keeps running.
        detach: async () => completion.resolve({ exitCode: 0 }),
      }
      return handle
    },
    observe: async (identity) => {
      observed.push(identity.commandId ?? '')
      return observation
    },
  }
  const workspaces = new Proxy(h.wiring.workspaces, {
    get(target, key, receiver) {
      if (key === 'harvestExecution') return execution
      if (key === 'recovery')
        return {
          fence: async () => ({ outcome: 'confirmed' as const }),
          reap: async (handle: WorkspaceHandle) => {
            reaps.push(handle)
            return {
              outcome: 'confirmed' as const,
              snapshots: { outcome: 'confirmed' as const, deleted: 1 },
            }
          },
        }
      return Reflect.get(target, key, receiver)
    },
  })

  const repoEvents = (): Promise<RepositoryEvent[]> => h.store.getRepoEvents(h.remote)
  const count = async (type: RepositoryEvent['type']) =>
    (await repoEvents()).filter((event) => event.type === type).length
  const losses = async () =>
    (await repoEvents()).filter(
      (event) => event.type === 'harvest.failed' && event.payload.error === LOSS,
    )
  const synthesizeOpen = async () => {
    const run = reduceHarvest(await repoEvents()).latest
    const session = run?.sessions.at(-1)
    return session?.step === 'synthesize' && session.status === 'open'
  }

  /** One hosted cron invocation: `--once` bounded by a deadline whose expiry
   * the test fires. With `expireWhen`, the timer fires once that holds. */
  const invoke = async (expireWhen?: () => Promise<boolean>): Promise<string[]> => {
    const armed = new Map<number, () => void>()
    let next = 0
    const timers: TimerScheduler = {
      setTimeout(handler) {
        next += 1
        armed.set(next, handler)
        return next
      },
      clearTimeout(handle) {
        armed.delete(handle as number)
      },
    }
    const stderr: string[] = []
    const invocation = abDispatch({
      targetRepo: h.origin,
      env: {},
      exec: spawnExec,
      stdout: () => {},
      stderr: (line) => stderr.push(line),
      once: true,
      deadlineAt: h.clock().getTime() + 30 * 24 * 3_600_000,
      timers,
      wire: () => ({ ...h.wiring, workspaces }),
    })
    if (expireWhen !== undefined) {
      await until(async () => armed.size > 0 && (await expireWhen()), 'the deadline to arm')
      for (const [handle, handler] of [...armed]) {
        armed.delete(handle)
        handler()
      }
    }
    await invocation
    return stderr
  }

  const seed = async (): Promise<void> => {
    const slug = 'hosted-source'
    const ticket = { source: 'fake', id: `source-${slug}`, title: slug }
    await h.store.createBuild({ slug, repo: h.remote, ticket })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.created',
      payload: { ticket, repo: h.remote, baseBranch: 'main' },
    })
    await h.store.append(slug, {
      actor: agentActor('implement', `source-session-${slug}`),
      type: 'observation.recorded',
      payload: { id: `obs-${slug}`, kind: 'latent-bug', summary: 'hosted harvest defect' },
    })
    await h.store.append(slug, {
      actor: DISPATCHER,
      type: 'build.completed',
      payload: { outcome: 'merged' },
    })
  }

  return {
    h,
    starts,
    reaps,
    observed,
    synthesizeGate,
    observe: (next: ExecutionObservation) => {
      observation = next
    },
    guest: () => guest,
    repoEvents,
    count,
    losses,
    synthesizeOpen,
    invoke,
    seed,
  }
}

async function assertUntouched(fx: Awaited<ReturnType<typeof hostedFixture>>): Promise<void> {
  expect(fx.starts).toHaveLength(1)
  expect(await fx.count('harvest.failed')).toBe(0)
  expect(await fx.count('harvest.recovery-requested')).toBe(0)
  expect(await fx.count('harvest.execution.released')).toBe(0)
  expect(await fx.synthesizeOpen()).toBe(true)
}

test('a synthesize session spanning several hosted invocations completes with no loss', async () => {
  const fx = await hostedFixture()
  try {
    await fx.seed()
    await fx.invoke(fx.synthesizeOpen)
    expect(fx.starts).toHaveLength(1)
    expect(await fx.count('harvest.execution.started')).toBe(1)

    for (let i = 0; i < 2; i += 1) {
      await fx.invoke()
      await assertUntouched(fx)
    }
    expect(fx.observed).toEqual(['cmd-1', 'cmd-1'])

    fx.synthesizeGate.resolve()
    await fx.guest()
    expect(await fx.count('harvest.completed')).toBe(1)

    fx.observe({ state: 'ended', exitCode: 0 })
    await fx.invoke()
    expect(await fx.count('harvest.execution.released')).toBe(1)
    expect(await fx.count('harvest.failed')).toBe(0)
    expect(fx.starts).toHaveLength(1)
    expect(reduceHarvest(await fx.repoEvents()).latest?.status).toBe('completed')
    expect(fx.h.cliErrors).toEqual([])
  } finally {
    fx.synthesizeGate.resolve()
    await fx.guest()?.catch(() => {})
    await fx.h.cleanup()
  }
}, 60_000)

test('a killed hosted execution records exactly one runner loss and recovers', async () => {
  const fx = await hostedFixture()
  try {
    await fx.seed()
    await fx.invoke(fx.synthesizeOpen)
    await fx.invoke()
    await assertUntouched(fx)

    // The sandbox is gone while the guest's bracket is still open.
    fx.observe({ state: 'lost' })
    await fx.invoke()
    const events = await fx.repoEvents()
    const released = events.filter((event) => event.type === 'harvest.execution.released')
    expect(released.map((event) => event.payload.execution)).toContain(fx.starts[0]!.instance)
    const losses = await fx.losses()
    expect(losses).toHaveLength(1)
    const firstRelease = released.find(
      (event) => event.payload.execution === fx.starts[0]!.instance,
    )!
    expect(losses[0]!.seq).toBeGreaterThan(firstRelease.seq)
    expect(events.filter((event) => event.type === 'harvest.recovery-requested')).toHaveLength(1)
    expect(fx.starts).toHaveLength(2)

    await fx.invoke()
    expect(await fx.losses()).toHaveLength(1)
  } finally {
    fx.synthesizeGate.resolve()
    await fx.guest()?.catch(() => {})
    await fx.h.cleanup()
  }
}, 60_000)
