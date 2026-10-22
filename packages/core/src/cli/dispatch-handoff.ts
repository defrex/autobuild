import { rollbackRuntimeRetained } from './dispatch-runtime-use'
import { join, resolve, dirname } from 'node:path'
import { openSessionlessStore, openProductionStore, type StoreOpener } from './store-opening'
import { projectToken } from './project-credentials'
import { spawnExec } from '../ports/workspace/git-worktree'
import { parseDispatchArgs } from './dispatch-args'
import { readDispatchUpgrade, readDispatcherRunFacts } from '../store/reduced-reads'
import { cachedRuntime } from './dispatch-runtime-cache'
import type { GenerationLaunch } from './dispatch-launch-contract'
import type { Handoff } from '../kernel/dispatch-upgrade'

/** Once a held run identifies its journal, readers retain that transport
 * identity across rejected configuration edits. It conveys no lifecycle result. */
export async function openGenerationStore(
  launch: GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
  openStore?: StoreOpener,
) {
  if (launch.journal) {
    const { storeRef, repo } = launch.journal
    const token = /^https?:/i.test(storeRef) ? projectToken(storeRef, repo, env) : env.AB_TOKEN
    return { store: (openStore ?? openProductionStore)(storeRef, token), storeRef, repo }
  }
  const args = parseDispatchArgs(argv.slice(1), env)
  return openSessionlessStore({
    targetRepo: launch.checkout,
    exec: spawnExec,
    env,
    storeRef: args.storeRef,
    ...(openStore ? { openStore } : {}),
  })
}

/** Initial transport bootstrap: initialize/read the repository record, without
 * claiming its lease or starting dispatch work, then return its query identity. */
export async function readGenerationJournal(
  launch: GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
) {
  const opened = await openGenerationStore(launch, argv, env)
  try {
    await opened.store.ensureRepo(opened.repo)
    return {
      version: 1,
      rollbackVersion: 1,
      journal: { storeRef: opened.storeRef, repo: (await opened.store.getRepo(opened.repo))!.repo },
    }
  } finally {
    await opened.store.close()
  }
}

/** Runtime-owned store reader. The filesystem-only launcher consumes this versioned result. */
export async function readHandoff(
  launch: GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
  live = false,
): Promise<Handoff | undefined> {
  if (!launch.run || !launch.lineage) return undefined
  const opened = await openGenerationStore(launch, argv, env)
  try {
    if (!(await opened.store.getRepo(opened.repo))) return undefined
    const state = (await readDispatchUpgrade(opened.store, opened.repo)).value.runs[launch.run]
    const selected = live ? state?.prepared : state?.handoff
    if (!selected || (!live && state?.completed) || state?.failure) return undefined
    const facts = (await readDispatcherRunFacts(opened.store, opened.repo, launch.run)).value
    const handoff = selected.payload
    if (
      (!live &&
        (facts.stop?.type !== 'dispatcher.run-stopped' ||
          facts.stop.payload.outcome !== 'normal' ||
          facts.stop.payload.signal !== undefined)) ||
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

export async function readUpgradeProjection(
  launch: GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
) {
  const opened = await openGenerationStore(launch, argv, env)
  try {
    const record = await opened.store.getRepo(opened.repo)
    const journal =
      launch.journal ??
      (record?.lease?.holder === launch.run
        ? { storeRef: opened.storeRef, repo: opened.repo }
        : undefined)
    if (!journal) return { version: 1, handoff: null, takeover: false }
    const handoff = await readHandoff({ ...launch, journal }, argv, env, true)
    const upgrades = (await readDispatchUpgrade(opened.store, opened.repo)).value
    const state = upgrades.runs[launch.run!]
    const rollbackRecorded =
      !!launch.rollback && upgrades.rollbackIds.includes(launch.rollback.correlation)
    const hold = launch.lineage ? upgrades.holds[launch.lineage] : undefined
    return {
      version: 1,
      journal,
      handoff: handoff ?? null,
      rollbackVersion: 1,
      rollbackRetained:
        rollbackRecorded &&
        (!hold || rollbackRuntimeRetained(hold.payload.failedRoot, launch.lineage!)),
      takeover: !!state?.takeover,
      takeoverAt: state?.takeover?.ts,
      takeoverPayload: state?.takeover?.payload,
      completed: !!state?.completed,
      accepted: !!state?.handoff,
      successor: state?.request?.payload.successor,
      released: !!state?.released,
    }
  } finally {
    await opened.store.close()
  }
}
export async function recordPreflightFailure(
  launch: GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
  correlation: string,
  reason: string,
) {
  const opened = await openGenerationStore(launch, argv, env)
  try {
    const state = (await readDispatchUpgrade(opened.store, opened.repo)).value.runs[launch.run!]
    const facts = (await readDispatcherRunFacts(opened.store, opened.repo, launch.run!)).value
    if (facts.stopRequest) return
    const handoff = state?.prepared?.payload
    if (!handoff || handoff.correlation !== correlation || state.handoff || state.failure) return
    const { DISPATCHER } = await import('../events/envelope')
    const { createReadinessRedactor } = await import('./init-readiness-shared')
    await opened.store.appendRepo(opened.repo, {
      actor: DISPATCHER,
      type: 'dispatcher.upgrade-failed',
      payload: {
        correlation,
        run: handoff.run,
        lineage: handoff.lineage,
        from: handoff.from,
        target: handoff.target,
        reason: createReadinessRedactor(env)(reason),
      },
    })
  } finally {
    await opened.store.close()
  }
}

/** The launcher may recover presentation after the exact old process exits.
 * It restores its inherited terminal first; this command records that work. */
export async function recoverTerminalRelease(
  launch: GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<void> {
  if (launch.launcherPid !== process.ppid)
    throw new Error('terminal recovery requires the owning launcher')
  const opened = await openGenerationStore(launch, argv, env)
  try {
    const state = (await readDispatchUpgrade(opened.store, opened.repo)).value.runs[launch.run!]
    const facts = (await readDispatcherRunFacts(opened.store, opened.repo, launch.run!)).value
    if (
      !state?.handoff ||
      !state.request ||
      state.released ||
      state.failure ||
      facts.stopRequest ||
      state.handoff.payload.lineage !== launch.lineage
    )
      return
    const { DISPATCHER } = await import('../events/envelope')
    await opened.store.appendRepo(opened.repo, {
      actor: DISPATCHER,
      type: 'dispatcher.terminal-released',
      payload: state.prepared!.payload,
    })
  } finally {
    await opened.store.close()
  }
}

/** Validate against durable takeover, then publish only under repository authority. */
export async function recordRuntimeRollback(
  store: import('../store/types').BuildStore,
  repo: string,
  launch: GenerationLaunch,
  run: string,
): Promise<void> {
  const context = launch.rollback
  if (launch.recovery) {
    const recovery = launch.recovery
    const state = (await readDispatchUpgrade(store, repo)).value.runs[recovery.predecessor]
    if (
      !state?.takeover ||
      state.takeover.payload.successor !== recovery.successor ||
      state.takeover.payload.correlation !== recovery.handoff ||
      state.takeover.payload.lineage !== launch.lineage ||
      state.takeover.payload.root !== launch.runtimeRoot
    )
      throw new Error('recovery has no matching durable takeover')
  }
  if (!context) return
  const { validRecoveryContext } = await import('./dispatch-launch-contract')
  if (!validRecoveryContext(launch)) throw new Error('invalid rollback launch context')
  const upgrades = (await readDispatchUpgrade(store, repo)).value
  const takeover = upgrades.runs[context.predecessor]?.takeover
  const payload = takeover?.payload
  if (
    !payload ||
    takeover.ts !== context.takeoverAt ||
    payload.correlation !== context.handoff ||
    payload.lineage !== context.lineage ||
    payload.successor !== context.successor ||
    payload.root !== context.failed.root ||
    payload.from.source.location !== context.restored.root ||
    payload.cacheId !== context.failed.cacheId
  )
    throw new Error('rollback has no matching durable takeover and cached runtimes')
  if ((await store.getRepo(repo))?.lease?.holder !== run)
    throw new Error('rollback requires repository authority')
  // A cleared hold may already have released its cache entry. Its correlation
  // remains durable and must never republish/revalidate that consumed launch.
  if (upgrades.rollbackIds.includes(context.correlation)) return
  const [failed, restored] = await Promise.all([
    cachedRuntime(context.failed.root),
    cachedRuntime(context.restored.root),
  ])
  const { captureRuntimeIdentity } = await import('../runtime-identity')
  const sameRuntime = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (
    failed?.id !== context.failed.cacheId ||
    restored?.id !== context.restored.cacheId ||
    !sameRuntime(payload.from, captureRuntimeIdentity(context.restored.root)) ||
    !sameRuntime(payload.to, captureRuntimeIdentity(context.failed.root))
  )
    throw new Error('rollback has no matching durable takeover and cached runtimes')
  const { DISPATCHER } = await import('../events/envelope')
  await store.appendRepo(repo, {
    actor: DISPATCHER,
    type: 'dispatcher.runtime-rolled-back',
    payload: {
      correlation: context.correlation,
      run,
      lineage: context.lineage,
      predecessor: context.predecessor,
      successor: context.successor,
      handoff: context.handoff,
      takeoverAt: context.takeoverAt,
      failures: 3,
      failed: payload.to,
      restored: payload.from,
      failedRoot: context.failed.root,
      restoredRoot: context.restored.root,
      target: payload.target,
      reason: 'three failed generation exits within ten minutes of takeover',
    },
  })
}
