import { join, resolve, dirname } from 'node:path'
import { openSessionlessStore } from './store-opening'
import { spawnExec } from '../ports/workspace/git-worktree'
import { parseDispatchArgs } from './dispatch-args'
import { readDispatchUpgrade, readDispatcherRunFacts } from '../store/reduced-reads'
import { cachedRuntime } from './dispatch-runtime-cache'
import type { GenerationLaunch } from './dispatch-launch-contract'
import type { Handoff } from '../kernel/dispatch-upgrade'

/** Runtime-owned store reader. The filesystem-only launcher consumes this versioned result. */
export async function readHandoff(
  launch: GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<Handoff | undefined> {
  if (!launch.run || !launch.lineage) return undefined
  const args = parseDispatchArgs(argv.slice(1), env)
  const opened = await openSessionlessStore({
    targetRepo: launch.checkout,
    exec: spawnExec,
    env,
    storeRef: args.storeRef,
  })
  try {
    const state = (await readDispatchUpgrade(opened.store, opened.repo)).value.runs[launch.run]
    if (!state?.handoff || state.completed) return undefined
    const facts = (await readDispatcherRunFacts(opened.store, opened.repo, launch.run)).value
    const handoff = state.handoff.payload
    if (
      facts.stop?.type !== 'dispatcher.run-stopped' ||
      facts.stop.payload.outcome !== 'normal' ||
      facts.stop.payload.signal !== undefined ||
      facts.stopRequest ||
      handoff.lineage !== launch.lineage
    )
      return undefined
    const expected = join(launch.checkout, '.autobuild/runtime', handoff.cacheId, 'distribution')
    if (
      resolve(handoff.root) !== expected ||
      dirname(dirname(handoff.root)) !== join(launch.checkout, '.autobuild/runtime')
    )
      return undefined
    const candidate = await cachedRuntime(handoff.root)
    if (candidate?.id !== handoff.cacheId) return undefined
    return handoff
  } finally {
    await opened.store.close()
  }
}
