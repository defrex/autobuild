import { expect, test } from 'bun:test'
import { MemoryBuildStore } from '../store/memory'
import { DISPATCHER } from '../events/envelope'
import { readDispatchUpgrade } from '../store/reduced-reads'
import { manualClock } from '../testing/fixed'
import { recoverDispatchDrain } from './dispatch-drain-recovery'

for (const recoveryRun of [undefined, 'restored'])
  for (const knownEnd of [false, true])
    test(`successor reconstructs crashed retirement after execution fencing (end before authorization: ${knownEnd}, recovery: ${recoveryRun})`, async () => {
      const clock = manualClock()
      const store = new MemoryBuildStore({ clock })
      const runtime = {
        version: '1.0.0',
        commit: 'unknown',
        source: { kind: 'package' as const, location: '/old' },
      }
      const handoff = {
        correlation: 'upgrade',
        run: 'old',
        lineage: 'launcher',
        from: runtime,
        to: { ...runtime, version: '2.0.0' },
        root: '/new',
        cacheId: 'new',
        target: { mode: 'installed' as const, key: 'new', source: '/install' },
      }
      await store.ensureRepo('repo')
      await store.createBuild({ slug: 'build', repo: 'repo' })
      if (knownEnd)
        await store.append('build', {
          actor: DISPATCHER,
          type: 'execution.ended',
          payload: { instance: 'execution', workspaceRef: 'ws', outcome: 'completed' },
        })
      await store.append('build', {
        actor: DISPATCHER,
        type: 'execution.drain-authorized',
        payload: { correlation: 'upgrade', run: 'old', runtime, instance: 'execution' },
      })
      await store.claimLease('build', 'execution', 1_000)
      await store.claimRepoLease('repo', 'new', 60_000)
      await store.appendRepo('repo', {
        actor: DISPATCHER,
        type: 'dispatcher.target-prepared',
        payload: handoff,
      })
      await store.appendRepo('repo', {
        actor: DISPATCHER,
        type: 'dispatcher.yield-requested',
        payload: { ...handoff, successor: 'new', mode: 'drain', evidence: 'same schema' },
      })
      await store.appendRepo('repo', {
        actor: DISPATCHER,
        type: 'dispatcher.handoff-started',
        payload: {
          ...handoff,
          successor: 'new',
          mode: 'drain',
          startedAt: clock().toISOString(),
          deadline: new Date(clock().getTime() + 900_000).toISOString(),
          builds: [{ slug: 'build', instance: 'execution' }],
        },
      })
      await store.appendRepo('repo', {
        actor: DISPATCHER,
        type: 'dispatcher.terminal-released',
        payload: handoff,
      })
      if (recoveryRun) {
        await store.releaseRepoLease('repo', 'new')
        await store.claimRepoLease('repo', recoveryRun, 60_000)
        // A foreign run cannot settle even after acquiring authority.
        expect(await recoverDispatchDrain(store, 'repo', 'old', clock(), recoveryRun)).toBe(false)
        await store.appendRepo('repo', {
          actor: DISPATCHER,
          type: 'dispatcher.run-started',
          payload: {
            run: recoveryRun,
            lineage: 'launcher',
            pid: 1,
            effectiveConfig: { kind: 'config', rev: 0 },
            roleWarnings: [],
          },
        })
      }
      expect(await recoverDispatchDrain(store, 'repo', 'old', clock(), recoveryRun)).toBe(false)
      expect((await readDispatchUpgrade(store, 'repo')).value.runs.old!.outstanding).toEqual({
        build: 'execution',
      })
      clock.advance(1_001)
      expect(await recoverDispatchDrain(store, 'repo', 'old', clock(), recoveryRun)).toBe(true)
      const count = (await store.getRepoEvents('repo')).length
      expect(await recoverDispatchDrain(store, 'repo', 'old', clock(), recoveryRun)).toBe(true)
      expect((await store.getRepoEvents('repo')).length).toBe(count)
      const state = (await readDispatchUpgrade(store, 'repo')).value.runs.old!
      expect(state.outstanding).toEqual({})
      expect(state.drained).toBe(knownEnd ? 1 : 0)
      expect(state.suspended).toBe(0)
      expect(state.completed?.payload.mode).toBe('drain')
      await store.close()
    })
