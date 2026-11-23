import { nodeRestackDemand, restackAvailabilityFingerprint } from './node-restack-demand'
import { observeTarget } from './target-observation'
import { deferMixedVersion, MixedVersionDeferral } from './mixed-version'
import { suspendNativeLanding } from './landing-publication'
import { observePresence, presenceInputs } from './change-presence'
import { readBuildDigests, readBuildFacts } from '../store/reduced-reads'
import type { BuildStore } from '../store/types'
import type { EventWrite } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import { snapshotParent } from './snapshot-parent'
import { recordHeadPaths } from './head-paths'
import { consentRevocation, resolutionPathsFor, revocableConsent } from './consent-revocation'
import type { RestackDeps } from './reconcile-restack'
import { retainReplay, restoreReplay, requireRewrite } from './reconcile-restack'
import {
  recordRetention,
  recoverReservedInput,
  retainCommit,
  type RetentionContext,
} from './history-retention'
import {
  prepareNodeReplay,
  assertSafeNodeReplay,
  replayNodeChange,
  nodeInventory,
  history,
} from './node-restack'

export interface NodeTransactionDeps extends RestackDeps {
  /** Confirm targeting-leaf native landing suspension before reservation and
   * again when recovering a frozen replay. Operation identities survive restart. */
  beforeReplay?: (operation: string) => Promise<void>
  holder: string
  /** Lifecycle and writer authority are rechecked at each effect boundary. */
  canWrite: () => Promise<boolean>
}
/** Best-effort retention for node writes: the forge archive ref, else a
 * BuildStore copy excluding `exclude`, else one warning. */
export function nodeRetention(
  deps: Pick<RestackDeps, 'store' | 'slug' | 'exec' | 'workspacePath' | 'forge'>,
  archive: RetentionContext['archive'],
  exclude: string,
  branches: { branch?: string; targetBranch?: string },
  exec: RestackDeps['exec'] = deps.exec,
): RetentionContext {
  return {
    store: deps.store,
    slug: deps.slug,
    exec,
    workspacePath: deps.workspacePath,
    archive,
    exclude,
    local: deps.forge.name === 'local-git',
    ...(branches.branch === undefined ? {} : { branch: branches.branch }),
    ...(branches.targetBranch === undefined ? {} : { targetBranch: branches.targetBranch }),
  }
}
async function current(store: BuildStore, slug: string) {
  return (await readBuildFacts(store, slug)).value.state
}
async function authority(deps: NodeTransactionDeps) {
  if (await deferMixedVersion(deps.store, deps.slug, KERNEL)) throw new MixedVersionDeferral()
  if (!(await deps.canWrite()) || !(await deps.store.renewNodeWriter(deps.slug, deps.holder)))
    throw new Error('node writer authority lost')
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
  let revision = state.lastSeq
  const append = async (event: EventWrite) => {
    await authority(deps)
    const written = await deps.store.appendIfCurrent(deps.slug, revision, event)
    if (!written) throw new Error('node writer log advanced; retry reserved operation')
    revision = written.seq
    return written
  }
  const record = await deps.store.getBuild(deps.slug)
  if (!record) throw new Error('missing node build')
  // Every repository build, mixed-version deferred ones included: the
  // dispatcher's availability batch mirrors this set so both fingerprints agree.
  const records = await deps.store.listBuildsForRepo(record.repo)
  const digests = await readBuildDigests(deps.store, record.repo)
  const entries = records.flatMap((record) => {
    const digest = digests.get(record.slug)
    return digest ? [{ record, digest }] : []
  })
  const evidence = await presenceInputs(
    { buildFacts: async (slug) => (await readBuildFacts(deps.store, slug)).value },
    entries,
    [deps.slug],
  )
  let node = state.nodeRestack
  if (!node?.active) {
    if (!node?.contributionBase && !state.nodeOpened?.sha)
      throw new Error('node has no durable contribution boundary')
    const destinationRef = `refs/autobuild/reconcile/${deps.slug}/${input.id}/node`
    const expected = await rewrite.snapshot({
      workspacePath: deps.workspacePath,
      branch: input.branch,
      destinationRef,
    })
    // Locate a recorded source mapping in this sampled head's first-parent
    // history. The extension is validated by prepareNodeReplay; the current
    // mutable destination never supplies an ownership boundary.
    const boundaries = node?.contributionBoundaries ?? {}
    const source =
      boundaries[expected] === undefined
        ? (await history(deps, [expected], ['--first-parent'])).find(
            (commit) => boundaries[commit.sha] !== undefined,
          )?.sha
        : expected
    const oldBase = source ? boundaries[source]! : state.nodeOpened?.sha
    if (!oldBase) throw new Error('node source provenance unavailable; operator review required')
    const parent = await snapshotParent(deps, input.parentBranch, `${destinationRef}-parent-head`)
    const admission = await observeTarget({
      store: deps.store,
      forge: deps.forge,
      slug: deps.slug,
      branch: input.parentBranch,
      sha: parent,
      enforceUsedBaseline: true,
      actor: KERNEL,
    })
    if (admission === 'rejected') return 'idle'
    state = await current(deps.store, deps.slug)
    revision = state.lastSeq
    node = state.nodeRestack
    // Observe immutable Git distance even while the node intentionally trails.
    const base = node?.contributionBase ?? oldBase
    if (
      node?.distance?.base !== base ||
      node.distance.parent !== parent ||
      node.distance.branch !== input.parentBranch
    ) {
      const result = await deps.exec(['git', 'rev-list', '--count', `${base}..${parent}`], {
        cwd: deps.workspacePath,
      })
      const count =
        result.exitCode === 0 && /^\d+$/.test(result.stdout.trim())
          ? Number(result.stdout.trim())
          : null
      await append({
        actor: KERNEL,
        type: 'node.parent-distance',
        payload: { base, parent, branch: input.parentBranch, count },
      })
    }
    if (
      !Object.keys(node?.requests ?? {}).length &&
      !node?.parentChange &&
      (!nodeRestackDemand(state) || (parent === oldBase && base === oldBase))
    ) {
      if (node?.inventory?.head !== expected) {
        const inventory = await nodeInventory(deps, expected, oldBase)
        if (JSON.stringify(inventory) !== JSON.stringify(node?.inventory))
          await append({
            actor: KERNEL,
            type: 'node.inventory',
            payload: { ...inventory, base: oldBase },
          })
      }
      return 'idle'
    }
    const upstream = await observePresence(deps, parent, evidence.landings, evidence.aliases, true)
    const destinationPresence = await observePresence(
      deps,
      expected,
      evidence.landings,
      evidence.aliases,
      true,
    )
    for (const request of Object.values(node?.requests ?? {})) {
      if (request.branch !== input.parentBranch) {
        await append({
          actor: KERNEL,
          type: 'node.restack-satisfied',
          payload: { id: request.id, parent, outcome: 'destination-changed' },
        })
        continue
      }
      const covered = await deps.exec(
        ['git', 'merge-base', '--is-ancestor', request.parent, base],
        { cwd: deps.workspacePath },
      )
      if (
        (request.reason === 'presence' || (base === parent && covered.exitCode === 0)) &&
        (request.identities ?? []).every((id) => new Set<string>(destinationPresence).has(id))
      )
        await append({
          actor: KERNEL,
          type: 'node.restack-satisfied',
          payload: { id: request.id, parent: base, outcome: 'covered' },
        })
    }
    state = await current(deps.store, deps.slug)
    node = state.nodeRestack
    const availableRequests = Object.values(node?.requests ?? {}).filter(
      (request) =>
        request.branch === input.parentBranch &&
        (request.identities ?? []).every((id) => new Set<string>(upstream).has(id)),
    )
    const fingerprint = restackAvailabilityFingerprint(
      state,
      input.branch,
      input.parentBranch,
      expected,
      parent,
      evidence,
    )
    if (node?.availability?.fingerprint !== fingerprint)
      await append({
        actor: KERNEL,
        type: 'node.restack-availability-observed',
        payload: {
          version: 1,
          fingerprint,
          branch: input.branch,
          parentBranch: input.parentBranch,
          head: expected,
          parent,
          base,
          available: availableRequests.map((r) => r.id).sort(),
        },
      })
    const demanded = nodeRestackDemand({
      ...state,
      nodeRestack: {
        ...node!,
        requests: Object.fromEntries(availableRequests.map((request) => [request.id, request])),
      },
    })
    if (
      !demanded ||
      (parent === oldBase && oldBase === node?.contributionBase && !node?.parentChange)
    ) {
      if (node?.inventory?.head === expected) return 'idle'
      const inventory = await nodeInventory(deps, expected, oldBase)
      if (JSON.stringify(inventory) !== JSON.stringify(node?.inventory))
        await append({
          actor: KERNEL,
          type: 'node.inventory',
          payload: { ...inventory, base: oldBase },
        })
      return 'idle'
    }
    await deps.beforeReplay?.(input.id)
    await authority(deps)
    if ((await current(deps.store, deps.slug)).lastSeq !== revision)
      throw new Error('node inputs changed during native cancellation')
    const frozen = await prepareNodeReplay(deps, { oldBase, oldHead: expected, parent }, evidence)
    // Preserve frozen source objects before the reservation can survive a
    // workspace loss, best effort: a forge archive ref, else a store copy
    // over the published parent, else one warning. The inputs stay reachable
    // from published branches until the guarded update lands.
    await authority(deps)
    const archive = `refs/autobuild/archive/${deps.slug}/${expected}`
    const ctx = nodeRetention(deps, rewrite.archive, parent, {
      branch: input.branch,
      targetBranch: input.parentBranch,
    })
    const outcomes = [await retainCommit(ctx, expected), await retainCommit(ctx, oldBase)]
    await authority(deps)
    outcomes.push(await retainCommit(ctx, parent))
    await recordRetention(
      deps.store,
      deps.slug,
      { event: 'node.history-retained', operation: 'restack', id: input.id, base: parent },
      outcomes,
      append,
    )
    await append({
      actor: KERNEL,
      type: 'node.writer-reserved',
      payload: {
        id: input.id,
        operation: 'restack',
        requests: availableRequests.map((request) => request.id),
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
    throw new Error('recover reserved node merge before restacking')
  if (
    active.merges.some((proof) => proof.build || proof.missing.length) &&
    state.answeredEscalations.some(
      (answer) =>
        answer.phase === 'reconcile' && answer.answeredSeq > (node!.reservedSeq ?? Infinity),
    )
  ) {
    await append({
      actor: KERNEL,
      type: 'node.writer-settled',
      payload: { id: active.id, outcome: 'abandoned' },
    })
    return runNodeTransaction(deps, input)
  }
  await deps.beforeReplay?.(active.id)
  await authority(deps)
  // A retained prefix is restored before any Git read uses it, even if its
  // original workspace and all unreferenced Git objects have disappeared.
  const inputs = await restoreNodeInputs(deps, rewrite, active, input, !!node!.rewritten)
  if (inputs === 'unavailable') {
    // Retained nowhere and not yet published: redo from the published branches.
    await append({
      actor: KERNEL,
      type: 'node.writer-settled',
      payload: { id: active.id, outcome: 'abandoned' },
    })
    return runNodeTransaction(deps, input)
  }
  const frozen = { ...active, oldHead: active.expected }
  assertSafeNodeReplay(frozen)
  const replayEvidence = {
    ...evidence,
    upstream: new Set(
      await observePresence(deps, active.parent, evidence.landings, evidence.aliases, true),
    ),
  }
  for (const item of node!.items) {
    if (!item.dropped && !(await restoreReplay(deps, item.head)))
      throw new Error(`missing retained node replay ${item.head}`)
  }
  if (node!.conflict) return 'conflict'
  for (let index = node!.items.length; index < active.changes.length; index++) {
    const base = node!.items.at(-1)?.head ?? active.parent
    await append({
      actor: KERNEL,
      type: 'node.item-prepared',
      payload: { id: active.id, index, base },
    })
    const result = await replayNodeChange(deps, frozen, index, base, replayEvidence)
    if (result.kind === 'conflict') {
      await append({
        actor: KERNEL,
        type: 'node.item-conflicted',
        payload: { id: active.id, index, base, files: result.files },
      })
      return 'conflict'
    }
    if (result.kind === 'replayed') await retainReplay(deps, result.head, base)
    await append({
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
  // Record the head's paths before its publication intent; items a resolver
  // finished after a conflict carry the node head's reconcile resolution.
  await authority(deps)
  const resolution = (node!.resolved ?? []).map((index) => {
    const change = active.changes[index]!
    const item = node!.items[index]!
    return {
      change: change.sha,
      parent: `${change.sha}^${change.mainline ?? 1}`,
      ...(change.mainline === undefined ? {} : { mainline: change.mainline }),
      onto: item.base,
      head: item.head,
    }
  })
  const latest = await current(deps.store, deps.slug)
  // A recovered publication intent predates this attempt's revision chain,
  // exactly as the rewrite below refreshes it.
  if (node!.intent) revision = latest.lastSeq
  const recorded = await recordHeadPaths(
    { ...deps, actor: KERNEL },
    {
      source: 'node-rewrite',
      head,
      destination: active.parent,
      ...(resolution.length > 0 ? { resolution } : {}),
      state: latest,
      expectedSeq: revision,
    },
  )
  if (recorded === null) throw new Error('node writer log advanced; retry reserved operation')
  if (recorded.recorded === 'appended') revision = recorded.event.seq
  // Protected consent lapses when resolver-finished items edited protected
  // files. A recovered attempt reads state after any earlier revocation.
  if (resolution.length > 0 && revocableConsent(latest.landing)) {
    const revocation = consentRevocation(latest.landing, {
      source: 'node-rewrite',
      previousHead: active.expected,
      head,
      resolution: await resolutionPathsFor(deps.store, deps.slug, recorded),
    })
    if (revocation)
      await append({ actor: KERNEL, type: 'landing.consent-revoked', payload: revocation })
  }
  if (!node!.intent)
    await append({
      actor: KERNEL,
      type: 'node.publish-intended',
      payload: { id: active.id, head },
    })
  await authority(deps)
  await suspendNativeLanding(deps, active.id)
  revision = (await current(deps.store, deps.slug)).lastSeq
  const result = await rewrite.replace({
    workspacePath: deps.workspacePath,
    branch: input.branch,
    expected: active.expected,
    sha: head,
  })
  if (result.kind === 'lease-mismatch' && !result.rewritten) {
    await append({
      actor: KERNEL,
      type: 'node.writer-settled',
      payload: { id: active.id, outcome: 'contended', actual: result.actual },
    })
    return 'contended'
  }
  await append({
    actor: KERNEL,
    type: 'node.rewritten',
    payload: { id: active.id, previous: active.expected, head },
  })
  if (result.kind === 'lease-mismatch') {
    await append({
      actor: KERNEL,
      type: 'node.writer-settled',
      payload: {
        id: active.id,
        outcome: 'contended',
        actual: result.actual,
      },
    })
    return 'contended'
  }
  await append({
    actor: KERNEL,
    type: 'node.inventory',
    payload: await nodeInventory(deps, head, active.parent),
  })
  await append({
    actor: KERNEL,
    type: 'node.writer-settled',
    payload: { id: active.id, outcome: 'completed' },
  })
  for (const id of active.requests ?? [])
    await append({
      actor: KERNEL,
      type: 'node.restack-satisfied',
      payload: { id, parent: active.parent, outcome: 'covered' },
    })
  return 'completed'
}

/** Restore a reservation's frozen inputs: the parent first, since a store copy
 * of `expected` completes only over it. After the guarded update landed,
 * `expected` is used only as a sha, and the parent, an ancestor of the
 * published node head, must come back. */
async function restoreNodeInputs(
  deps: NodeTransactionDeps,
  rewrite: ReturnType<typeof requireRewrite>,
  active: { parent: string; expected: string; archive: string },
  input: { branch: string; parentBranch: string },
  rewritten: boolean,
): Promise<'present' | 'unavailable'> {
  const ctx = nodeRetention(deps, rewrite.archive, active.parent, {
    branch: input.branch,
    targetBranch: input.parentBranch,
  })
  if (!(await recoverReservedInput(ctx, active.parent))) {
    if (rewritten)
      throw new Error(`node restack parent ${active.parent} is unavailable after its rewrite`)
    return 'unavailable'
  }
  if (rewritten) return 'present'
  return (await recoverReservedInput(ctx, active.expected, active.archive))
    ? 'present'
    : 'unavailable'
}
