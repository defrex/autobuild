import { rollbackRuntimeRetained } from './dispatch-runtime-use'
import { join, resolve, dirname } from 'node:path'
import { openSessionlessStore, openProductionStore, type StoreOpener } from './store-opening'
import { projectToken } from './project-credentials'
import { spawnExec } from '../ports/workspace/git-worktree'
import { parseDispatchArgs } from './dispatch-args'
import { readDispatchUpgrade, readDispatcherRunFacts } from '../store/reduced-reads'
import { cachedRuntime } from './dispatch-runtime-cache'
import type {
  GenerationLaunch,
  UpgradeCondition,
  UpgradeGuards,
  UpgradeProjection,
  ConditionalUpgradeResult,
} from './dispatch-launch-contract'
import { validChangePosition } from './dispatch-launch-contract'
import type { UpgradeRun } from '../kernel/dispatch-upgrade'
type DispatcherRunFacts = Awaited<ReturnType<typeof readDispatcherRunFacts>>['value']
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
    return validateHandoff(launch, selectHandoff(launch, state, facts, live))
  } finally {
    await opened.store.close()
  }
}

/** Durable selection is separate from local cache validation. */
function selectHandoff(
  launch: GenerationLaunch,
  state: UpgradeRun | undefined,
  facts: DispatcherRunFacts,
  live: boolean,
): Handoff | null {
  const selected = live ? state?.prepared : state?.handoff
  if (!selected || (!live && state?.completed) || state?.failure) return null
  const handoff = selected.payload
  if (
    (!live &&
      (facts.stop?.type !== 'dispatcher.run-stopped' ||
        facts.stop.payload.outcome !== 'normal' ||
        facts.stop.payload.signal !== undefined)) ||
    facts.stopRequest ||
    handoff.lineage !== launch.lineage
  )
    return null
  return handoff
}
async function validateHandoff(
  launch: GenerationLaunch,
  handoff: Handoff | null,
): Promise<Handoff | undefined> {
  if (!handoff || handoff.lineage !== launch.lineage || handoff.run !== launch.run) return undefined
  const expected = join(launch.checkout, '.autobuild/runtime', handoff.cacheId, 'distribution')
  if (
    resolve(handoff.root) !== expected ||
    dirname(dirname(handoff.root)) !== join(launch.checkout, '.autobuild/runtime')
  )
    return undefined
  return (await cachedRuntime(handoff.root))?.id === handoff.cacheId ? handoff : undefined
}
async function localGuards(launch: GenerationLaunch, guards: UpgradeGuards) {
  return {
    handoff: (await validateHandoff(launch, guards.handoff)) ?? null,
    rollbackRetained:
      guards.rollbackRecorded &&
      (!guards.failedRoot || rollbackRuntimeRetained(guards.failedRoot, launch.lineage!)),
  }
}
export function readUpgradeProjection(
  launch: GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<UpgradeProjection>
export function readUpgradeProjection(
  launch: GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
  options: { openStore?: StoreOpener; condition?: UpgradeCondition },
): Promise<UpgradeProjection | ConditionalUpgradeResult>
export async function readUpgradeProjection(
  launch: GenerationLaunch,
  argv: string[],
  env: Record<string, string | undefined>,
  options: { openStore?: StoreOpener; condition?: UpgradeCondition } = {},
): Promise<UpgradeProjection | ConditionalUpgradeResult> {
  const opened = await openGenerationStore(launch, argv, env, options.openStore)
  try {
    const condition = options.condition
    // Sample before projection reads: concurrent appends invalidate the next poll.
    const position =
      condition && launch.journal
        ? await opened.store.getRepoChangePosition(opened.repo)
        : undefined
    if (position !== undefined && !validChangePosition(position))
      throw new Error('invalid upgrade change position')
    if (position !== undefined && condition?.position === position && condition.guards) {
      return {
        conditionalVersion: 1,
        kind: 'unchanged',
        identity: condition.identity,
        position,
        ...(await localGuards(launch, condition.guards)),
      }
    }
    const record = await opened.store.getRepo(opened.repo)
    const journal =
      launch.journal ??
      (record?.lease?.holder === launch.run
        ? { storeRef: opened.storeRef, repo: opened.repo }
        : undefined)
    let projection: UpgradeProjection = { version: 1, handoff: null, takeover: false }
    let guards: UpgradeGuards | undefined
    if (journal) {
      const upgrades = (await readDispatchUpgrade(opened.store, opened.repo)).value
      const state = upgrades.runs[launch.run!]
      const facts =
        launch.run && launch.lineage && record && state?.prepared && !state.failure
          ? (await readDispatcherRunFacts(opened.store, opened.repo, launch.run)).value
          : undefined
      const rollbackRecorded =
        !!launch.rollback && upgrades.rollbackIds.includes(launch.rollback.correlation)
      guards = {
        handoff: facts ? selectHandoff(launch, state, facts, true) : null,
        rollbackRecorded,
        failedRoot:
          rollbackRecorded && launch.lineage
            ? (upgrades.holds[launch.lineage]?.payload.failedRoot ?? null)
            : null,
      }
      projection = {
        version: 1,
        journal,
        rollbackVersion: 1,
        ...(await localGuards(launch, guards)),
        takeover: !!state?.takeover,
        takeoverAt: state?.takeover?.ts,
        takeoverPayload: state?.takeover?.payload,
        completed: !!state?.completed,
        accepted: !!state?.handoff,
        successor: state?.request?.payload.successor,
        released: !!state?.released,
      }
    }
    return condition
      ? {
          conditionalVersion: 1,
          kind: 'full',
          identity: condition.identity,
          projection,
          ...(position !== undefined && guards ? { position, guards } : {}),
        }
      : projection
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
