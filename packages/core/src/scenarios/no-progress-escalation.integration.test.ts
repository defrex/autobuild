import { expect, test } from 'bun:test'
import { controlBuild } from '../cli/build-control'
import { DISPATCHER, KERNEL } from '../events/envelope'
import { Dispatcher } from '../processes/dispatcher'
import { decideNext } from '../kernel/engine'
import { executionNoProgressReducer } from '../processes/execution-no-progress'
import { spawnExec } from '../ports/workspace/git-worktree'
import { happyHandlers, makeHarness, ofType, readyTicket } from './harness'

for (const text of [undefined, 'Inspect the configuration disagreement and retry']) {
  test(`dispatcher/runner disagreement stops after three executions; ${text ? 'guidance' : 'retry'} grants three more`, async () => {
    const dispatchConfig = (config: Parameters<typeof decideNext>[1]) => {
      config.verify.steps.push('disagreement')
      config.verify.stepConfigs.disagreement = { kind: 'check', command: 'test' }
      return config
    }
    const h = await makeHarness({
      handlers: happyHandlers(),
      tickets: [readyTicket('EMPTY')],
      dispatcherConfig: dispatchConfig,
    })
    const slug = 'add-rate-limiting'
    try {
      await h.dispatcher.tick()
      await h.runLatest() // The real pipeline reaches its open PR with the runner's config.
      const baseline = h.launched.length
      const runnerConfig = structuredClone(h.config)
      const config = dispatchConfig(structuredClone(h.config))
      let dispatcher = h.dispatcher
      // Every later execution runs the real BuildRunner, which parks awaiting PR,
      // while the dispatcher still expects a verification step absent from that config.
      const complete = async (exitCode = 0, progress = false) => {
        const entry = h.launched.at(-1)!
        const before = await h.events(slug)
        expect(decideNext(before, runnerConfig)).toEqual({ kind: 'wait', reason: 'awaiting-pr' })
        await h.store.append(slug, {
          actor: DISPATCHER,
          type: 'execution.started',
          payload: { provider: 'git-worktree', workspaceRef: h.origin, instance: entry.instance },
        })
        if (progress)
          await h.store.append(slug, {
            actor: KERNEL,
            type: 'observation.recorded',
            payload: { id: h.ids('obs'), kind: 'followup', summary: 'Progress fixture', files: [] },
          })
        await h.runLatest()
        await h.store.append(slug, {
          actor: DISPATCHER,
          type: 'execution.ended',
          payload: {
            instance: entry.instance,
            workspaceRef: h.origin,
            outcome: 'completed',
            exitCode,
          },
        })
      }
      // A progress execution and a failed execution both reset, rather than
      // consume, the three-clean-empty allowance.
      for (const mode of ['empty', 'progress', 'empty', 'failure'] as const) {
        await dispatcher.tick({ resumeCurrent: true })
        await complete(mode === 'failure' ? 1 : 0, mode === 'progress')
      }
      expect(executionNoProgressReducer.reduce(await h.events(slug)).count).toBe(0)
      const preEmpty = h.launched.length
      const preStarts = ofType(await h.events(slug), 'execution.started').length
      for (let i = 0; i < 3; i++) {
        await dispatcher.tick({ resumeCurrent: true })
        await complete()
      }
      expect(h.launched.length - preEmpty).toBe(3)
      expect(ofType(await h.events(slug), 'execution.started').length - preStarts).toBe(3)
      // Simulate supervisor restart in the third-end/raise crash gap. Its launch
      // callback must never be reached, even though routing still expects work.
      dispatcher = new Dispatcher({
        store: h.store,
        config,
        tickets: h.tickets,
        forge: h.forgeAdapter,
        workspaces: h.workspaces,
        repo: h.origin,
        exec: spawnExec,
        ids: h.ids,
        clock: h.clock,
        launchRunner: async () => {
          throw new Error('fourth execution provisioned')
        },
      })
      for (let i = 0; i < 3; i++) await dispatcher.tick({ resumeCurrent: true })
      const raised = ofType(await h.events(slug), 'escalation.raised')
      expect(raised).toHaveLength(1)
      expect(raised[0]!.payload).toMatchObject({
        source: 'policy',
        policyCause: 'execution-no-progress',
        phase: 'setup',
      })
      expect(raised[0]!.payload.question).toContain('3 consecutive executions')
      expect(raised[0]!.payload.question).toContain('disagreement')
      expect(h.launched.length - preEmpty).toBe(3)
      expect(ofType(await h.events(slug), 'execution.started').length - preStarts).toBe(3)
      await controlBuild({
        store: h.store,
        repo: h.origin,
        slug,
        user: 'operator',
        action: { kind: 'answer', text },
      })
      for (let i = 0; i < 3; i++) {
        await h.dispatcher.tick({ resumeCurrent: true })
        await complete()
      }
      await h.dispatcher.tick({ resumeCurrent: true })
      expect(h.launched.length - preEmpty).toBe(6)
      expect(ofType(await h.events(slug), 'execution.started').length - preStarts).toBe(6)
      expect(ofType(await h.events(slug), 'escalation.raised')).toHaveLength(2)
      expect(h.launched.length - baseline).toBe(10)
      expect(h.cliErrors).toEqual([])
    } finally {
      await h.cleanup()
    }
  }, 30_000)
}
