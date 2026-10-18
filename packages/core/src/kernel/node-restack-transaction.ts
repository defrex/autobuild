import { readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import type { EventWrite } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import type { RestackDeps } from './reconcile-restack'
import { retainReplay, restoreReplay, requireRewrite } from './reconcile-restack'
import {
  prepareNodeReplay,
  assertSafeNodeReplay,
  replayNodeChange,
  nodeInventory,
} from './node-restack'

export interface NodeTransactionDeps extends RestackDeps {
  holder: string
  /** Lifecycle and writer authority are rechecked at each effect boundary. */
  canWrite: () => Promise<boolean>
}
async function current(store: BuildStore, slug: string) {
  return (await readBuildFacts(store, slug)).value.state
}
async function authority(deps: NodeTransactionDeps) {
  if (!(await deps.store.renewNodeWriter(deps.slug, deps.holder)) || !(await deps.canWrite()))
    throw new Error('node writer authority lost')
}
async function append(deps: NodeTransactionDeps, event: EventWrite) {
  await authority(deps)
  const state = await current(deps.store, deps.slug)
  const written = await deps.store.appendIfCurrent(deps.slug, state.lastSeq, event)
  if (!written) throw new Error('node writer log advanced; retry reserved operation')
  return written
}
/** The caller provides an isolated worktree sharing the authoritative object
 * database. All receipts follow object retention; no public ref is touched
 * until preflight and the entire ordered replay have succeeded. */
export async function runNodeTransaction(
  deps: NodeTransactionDeps,
  input: {
    branch: string
    parentBranch: string
    id: string
  },
): Promise<'completed' | 'conflict' | 'contended' | 'idle'> {
  await authority(deps)
  const rewrite = requireRewrite(deps.forge)
  let state = await current(deps.store, deps.slug)
  let node = state.nodeRestack
  if (!node?.active) {
    const oldBase = node?.contributionBase ?? state.nodeOpened?.sha
    if (!oldBase) throw new Error('node has no durable contribution boundary')
    const destinationRef = `refs/autobuild/reconcile/${deps.slug}/${input.id}/node`
    const expected = await rewrite.snapshot({
      workspacePath: deps.workspacePath,
      branch: input.branch,
      destinationRef,
    })
    if (!deps.forge.snapshotBase)
      throw new Error('node restack requires authoritative parent snapshots')
    const parent = await deps.forge.snapshotBase({
      workspacePath: deps.workspacePath,
      base: input.parentBranch,
      destinationRef: `${destinationRef}-parent-head`,
    })
    if (parent === oldBase) {
      const inventory = await nodeInventory(deps, expected, oldBase)
      if (JSON.stringify(inventory) !== JSON.stringify(node?.inventory))
        await append(deps, { actor: KERNEL, type: 'node.inventory', payload: inventory })
      return 'idle'
    }
    const frozen = await prepareNodeReplay(deps, { oldBase, oldHead: expected, parent })
    // Preserve frozen source objects before the reservation can survive a
    // workspace loss. Archives also retain the previous boundary's history.
    await authority(deps)
    const archive = `refs/autobuild/archive/${deps.slug}/${expected}`
    await rewrite.archive({ workspacePath: deps.workspacePath, ref: archive, sha: expected })
    await rewrite.archive({
      workspacePath: deps.workspacePath,
      ref: `refs/autobuild/archive/${deps.slug}/${oldBase}`,
      sha: oldBase,
    })
    await authority(deps)
    await rewrite.archive({
      workspacePath: deps.workspacePath,
      ref: `refs/autobuild/archive/${deps.slug}/${parent}`,
      sha: parent,
    })
    await append(deps, {
      actor: KERNEL,
      type: 'node.writer-reserved',
      payload: {
        id: input.id,
        operation: 'restack',
        expected,
        parent,
        oldBase,
        archive,
        changes: frozen.changes,
        upstreamBuilds: frozen.upstreamBuilds,
        merges: frozen.merges,
      },
    })
    state = await current(deps.store, deps.slug)
    node = state.nodeRestack
  }
  const active = node!.active!
  if (active.operation !== 'restack')
    throw new Error('recover reserved node landing before restacking')
  if (
    active.merges.some((proof) => proof.build || proof.missing.length) &&
    state.answeredEscalations.some(
      (answer) =>
        answer.phase === 'reconcile' && answer.answeredSeq > (node!.reservedSeq ?? Infinity),
    )
  ) {
    await append(deps, {
      actor: KERNEL,
      type: 'node.writer-settled',
      payload: { id: active.id, outcome: 'abandoned' },
    })
    return runNodeTransaction(deps, input)
  }
  const frozen = { ...active, oldHead: active.expected }
  assertSafeNodeReplay(frozen)
  // A retained prefix is restored before it is used, even if its original
  // workspace and all unreferenced Git objects have disappeared.
  await rewrite.archive({
    workspacePath: deps.workspacePath,
    ref: active.archive,
    sha: active.expected,
  })
  await rewrite.archive({
    workspacePath: deps.workspacePath,
    ref: `refs/autobuild/archive/${deps.slug}/${active.parent}`,
    sha: active.parent,
  })
  for (const item of node!.items) {
    if (!item.dropped && !(await restoreReplay(deps, item.head)))
      throw new Error(`missing retained node replay ${item.head}`)
  }
  if (node!.conflict) return 'conflict'
  for (let index = node!.items.length; index < active.changes.length; index++) {
    const base = node!.items.at(-1)?.head ?? active.parent
    await append(deps, {
      actor: KERNEL,
      type: 'node.item-prepared',
      payload: { id: active.id, index, base },
    })
    const result = await replayNodeChange(deps, frozen, index, base)
    if (result.kind === 'conflict') {
      await append(deps, {
        actor: KERNEL,
        type: 'node.item-conflicted',
        payload: { id: active.id, index, base },
      })
      return 'conflict'
    }
    if (result.kind === 'replayed') await retainReplay(deps, result.head, base)
    await append(deps, {
      actor: KERNEL,
      type: 'node.item-replayed',
      payload: {
        id: active.id,
        index,
        base,
        head: result.head,
        dropped: result.kind === 'dropped',
        ...(result.kind === 'dropped' ? { dropReason: result.reason } : {}),
      },
    })
    node = (await current(deps.store, deps.slug)).nodeRestack!
  }
  const head = node!.items.at(-1)?.head ?? active.parent
  if (!node!.intent)
    await append(deps, {
      actor: KERNEL,
      type: 'node.publish-intended',
      payload: { id: active.id, head },
    })
  await authority(deps)
  const result = await rewrite.replace({
    workspacePath: deps.workspacePath,
    branch: input.branch,
    expected: active.expected,
    sha: head,
  })
  if (result.kind === 'lease-mismatch' && !result.rewritten) {
    await append(deps, {
      actor: KERNEL,
      type: 'node.writer-settled',
      payload: { id: active.id, outcome: 'contended', actual: result.actual },
    })
    return 'contended'
  }
  await append(deps, {
    actor: KERNEL,
    type: 'node.rewritten',
    payload: { id: active.id, previous: active.expected, head },
  })
  await append(deps, {
    actor: KERNEL,
    type: 'node.inventory',
    payload: await nodeInventory(deps, head, active.parent),
  })
  await append(deps, {
    actor: KERNEL,
    type: 'node.writer-settled',
    payload: { id: active.id, outcome: 'completed' },
  })
  return 'completed'
}
