import { inspectGitCandidate } from '../ports/workspace/commit-preservation'
import { createHash } from 'node:crypto'
import { deferMixedVersion, MixedVersionDeferral } from './mixed-version'
import { suspendNativeLanding } from './landing-publication'
import { readBuildFacts } from '../store/reduced-reads'
import { isRemoteWorkspace } from '../events/workspace-remote'
import type { AbEvent, EventWrite } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import { KERNEL } from '../events/envelope'
import type { BuildStore } from '../store/types'
import type { Forge } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { buildTrailers, withBuildTrailer } from './build-identity'
import { reconcileScratchViolations, phaseScratchRejection } from '../ports/workspace/phase-scratch'
import type { GeneratedEntry } from '../config/schema'
import { classifyGenerated, generatedSelectors } from './generated-files'
import { regenerateConflict, regenerationReason } from './generated-regeneration'
import {
  recordRetention,
  restoreCommit,
  retainCommit,
  RetainedHistoryUnavailable,
  archiveRef,
  type RetentionContext,
  type RetentionOutcome,
} from './history-retention'
import { readRetainedPack, RetainedCopyInvalid } from './replay-retention'

export type ReconcileTransaction = EventPayload<'reconcile.prepared'>
export interface RestackDeps {
  store: BuildStore
  slug: string
  workspacePath: string
  forge: Forge
  exec: Exec
  instance?: string
  clock?: import('../store/types').Clock
  beforeRewrite?: () => Promise<void>
  probeCandidate?: (input: {
    ref: string
    slug: string
    branch: string
    sha: string
    replayPack?: string
    /** The thin replay pack's exclusion base, present before it is applied. */
    replayBase?: string
    /** The published target branch that holds `replayBase`. */
    targetBranch?: string
  }) => Promise<boolean>
  automatic?: Pick<
    EventPayload<'restack.prepared'>,
    'trigger' | 'cycle' | 'observation' | 'message'
  >
}
/** The replay algorithm uses the reconcile record shape internally. Automatic
 * transactions have their own durable vocabulary and never fabricate a phase. */
async function replayHistory(deps: RestackDeps): Promise<readonly AbEvent[]> {
  const facts = (await readBuildFacts(deps.store, deps.slug)).value
  const recovery = facts.candidateRecoveries[deps.automatic ? 'restack' : 'reconcile']
  if (deps.automatic === undefined)
    return facts.reconcileHistory.filter(
      (event) => !('id' in event.payload && event.payload.id === recovery?.id),
    )
  const mapped: AbEvent[] = [
    ...facts.reconcileHistory.filter((e) => e.type === 'workspace.provisioned'),
  ]
  for (const event of facts.restackHistory) {
    if ('id' in event.payload && event.payload.id === recovery?.id) continue
    const type = event.type.replace('restack.', 'reconcile.')
    const payload = { ...event.payload, attempt: 1 }
    // Only replay mechanics consume these records; external writes below are
    // validated in the automatic vocabulary by the BuildStore.
    mapped.push({ ...event, type, payload } as AbEvent)
  }
  return mapped
}
async function replayAppend(deps: RestackDeps, write: EventWrite) {
  if (deps.automatic === undefined) return deps.store.append(deps.slug, write)
  if (!write.type.startsWith('reconcile.')) throw new Error('invalid replay fact')
  const payload = { ...write.payload } as Record<string, unknown>
  delete payload.attempt
  delete payload.artifact
  delete payload.conflicted
  if (write.type === 'reconcile.replayed')
    payload.conflicted = (write.payload as EventPayload<'reconcile.replayed'>).conflicted
  if (write.type !== 'reconcile.replayed' && write.type !== 'reconcile.contended') {
    const { trigger, cycle, observation, message } = deps.automatic
    Object.assign(payload, { trigger, cycle, observation, message })
  }
  return deps.store.append(deps.slug, {
    ...write,
    type: write.type.replace('reconcile.', 'restack.'),
    payload,
  } as EventWrite)
}
async function git(deps: RestackDeps, args: string[], allowFailure = false) {
  const result = await deps.exec(['git', ...args], { cwd: deps.workspacePath })
  if (result.exitCode !== 0 && !allowFailure)
    throw new Error(`reconcile git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result
}
async function output(deps: RestackDeps, args: string[]) {
  return (await git(deps, args)).stdout.trim()
}
/** Automatic canonicalization must not introduce a repository identity
 * requirement before landing. If config is absent, preserve the recorded
 * change's committer for this command only; never change repository config. */
async function commitGit(deps: RestackDeps, source: string, args: string[], allowFailure = false) {
  const config: string[] = []
  for (const [key, format] of [
    ['user.name', '%cn'],
    ['user.email', '%ce'],
  ]) {
    const configured = await git(deps, ['config', '--get', key!], true)
    if (configured.exitCode === 1 || configured.stdout.trim() === '')
      config.push(
        '-c',
        `${key}=${await output(deps, ['show', '-s', `--format=${format}`, source])}`,
      )
  }
  return git(deps, [...config, ...args], allowFailure)
}
export function requireRewrite(forge: Forge) {
  if (forge.rewrite === undefined)
    throw new Error(
      `${forge.name} lacks the reconcile rewrite capability; upgrade the forge plugin to support authoritative snapshots and expected-head guarded replacement`,
    )
  return forge.rewrite
}

type BuildFacts = Awaited<ReturnType<typeof readBuildFacts>>['value']
function targetBranchOf(facts: BuildFacts): string | undefined {
  return facts.state.baseBranch ?? facts.lastCreated?.payload.baseBranch
}
/** Best-effort history retention for one leaf rewrite transaction. */
function retention(
  deps: RestackDeps,
  facts: BuildFacts,
  transaction: { branch: string; targetBase: string },
  archive: RetentionContext['archive'],
  exec: RestackDeps['exec'] = deps.exec,
): RetentionContext {
  const targetBranch = targetBranchOf(facts)
  return {
    store: deps.store,
    slug: deps.slug,
    exec,
    workspacePath: deps.workspacePath,
    archive,
    exclude: transaction.targetBase,
    local: deps.forge.name === 'local-git',
    branch: transaction.branch,
    ...(targetBranch === undefined ? {} : { targetBranch }),
  }
}
async function restoreOrRedo(ctx: RetentionContext, sha: string) {
  if (!(await restoreCommit(ctx, sha))) throw new RetainedHistoryUnavailable(sha)
}

export { retainReplay, restoreReplay } from './replay-retention'
import { restoreChangeCommit, restoreReplay, retainReplay } from './replay-retention'

/** Restore a sandbox-only change from durable bytes without remote write access. */
export async function restoreChange(deps: RestackDeps, sha: string): Promise<boolean> {
  return (await restoreChangeCommit(deps, sha)) || restoreReplay(deps, sha)
}

/** Exact availability probes only. Transport/auth errors defer recovery;
 * successful empty ref reads plus absent replay bytes prove candidate loss. */
export async function recoverLostCandidate(
  deps: RestackDeps,
): Promise<'none' | 'available' | 'retired'> {
  const current = await readBuildFacts(deps.store, deps.slug)
  const request = current.value.publication.latestUncompletedRequest()
  if (!request || !current.value.publication.lostRecorded(request)) return 'none'
  const payload = request.payload
  if ((payload.operation !== 'reconcile' && payload.operation !== 'restack') || !payload.rewrite)
    return 'none'
  if (
    current.value.state.sessions.open.length ||
    current.value.state.status === 'paused' ||
    current.value.state.status === 'blocked' ||
    current.value.state.pendingCommands.length
  )
    return 'none'
  const record = await deps.store.getBuild(deps.slug)
  if (
    current.value.open &&
    record?.lease &&
    new Date(record.lease.expiresAt).getTime() > (deps.clock?.() ?? new Date()).getTime() &&
    (deps.instance === undefined ||
      current.value.open.instance !== deps.instance ||
      record.lease.holder !== deps.instance)
  )
    return 'none'
  const sha = payload.sha
  let retained: Awaited<ReturnType<typeof readRetainedPack>> = null
  try {
    retained = await readRetainedPack(deps.store, deps.slug, sha)
  } catch (error) {
    // A corrupt copy cannot restore the candidate; the other sources still can.
    if (!(error instanceof RetainedCopyInvalid)) throw error
  }
  const replayPack = retained ? Buffer.from(retained.pack).toString('base64') : undefined
  const targetBranch = targetBranchOf(current.value)
  const thin = {
    ...(retained?.base === undefined ? {} : { replayBase: retained.base }),
    ...(targetBranch === undefined ? {} : { targetBranch }),
  }
  const available = deps.probeCandidate
    ? await deps.probeCandidate({
        ref: current.value.workspace?.ref ?? '',
        slug: deps.slug,
        branch: payload.branch,
        sha,
        replayPack,
        ...thin,
      })
    : await inspectGitCandidate({
        exec: deps.forge.kernelExec ?? deps.exec,
        workspacePath: deps.workspacePath,
        branch: payload.branch,
        sha,
        archiveRef: archiveRef(deps.slug, sha),
        local: deps.forge.name === 'local-git',
        replayPack,
        ...thin,
      })
  if (available) {
    if (!current.value.workspace || !isRemoteWorkspace(current.value.workspace)) {
      const capability = deps.forge.kernelRewrite ?? requireRewrite(deps.forge)
      const rewrite = payload.rewrite
      const outcome = await retainCommit(
        retention(
          deps,
          current.value,
          { branch: payload.branch, targetBase: rewrite.targetBase },
          capability.archive,
          deps.forge.kernelExec ?? deps.exec,
        ),
        sha,
      )
      await recordRetention(
        deps.store,
        deps.slug,
        { operation: payload.operation, id: rewrite.id, base: rewrite.targetBase },
        [outcome],
      )
    }
    return 'available'
  }
  await retireCandidate(deps, current, request)
  return 'retired'
}

/** Retire a rewrite candidate that cannot be published: its request is
 * abandoned and the operation replays under a replacement id. */
export async function retireCandidate(
  deps: RestackDeps,
  current: Awaited<ReturnType<typeof readBuildFacts>>,
  request: NonNullable<ReturnType<BuildFacts['publication']['latestUncompletedRequest']>>,
): Promise<void> {
  const payload = request.payload
  if ((payload.operation !== 'reconcile' && payload.operation !== 'restack') || !payload.rewrite)
    throw new Error('only a rewrite candidate can be retired')
  if (await deferMixedVersion(deps.store, deps.slug, KERNEL)) throw new MixedVersionDeferral()
  if (
    !(await deps.store.appendIfCurrent(deps.slug, current.cursor, {
      actor: KERNEL,
      type: 'publication.candidate-retired',
      payload: {
        request: request.seq,
        operation: payload.operation,
        id: payload.rewrite.id,
        sha: payload.sha,
        replacementId: `${payload.rewrite.id}-recovery-${request.seq}`,
      },
    }))
  )
    throw new Error('publication changed during candidate recovery; retry')
}

/** Retain every recorded Git tip before a branch rewrite, best effort: a
 * forge archive ref, else a BuildStore copy, else one warning. Returns the
 * confirmed forge archives for the rewrite fact. */
export async function retainTips(
  deps: RestackDeps,
  transaction: { id: string; branch: string; targetBase: string },
  extra: string[] = [],
): Promise<{ ref: string; sha: string }[]> {
  const capability = requireRewrite(deps.forge)
  const facts = (await readBuildFacts(deps.store, deps.slug)).value
  const ctx = retention(deps, facts, transaction, capability.archive)
  const outcomes: RetentionOutcome[] = []
  for (const sha of new Set([...facts.gitTips, ...extra])) {
    // The forge capability may archive a remote-only object; after a refusal
    // retainCommit restores what it can and records anything else unretained.
    outcomes.push(await retainCommit(ctx, sha))
  }
  await recordRetention(
    deps.store,
    deps.slug,
    {
      operation: deps.automatic ? 'restack' : 'reconcile',
      id: transaction.id,
      base: transaction.targetBase,
    },
    outcomes,
  )
  return outcomes.flatMap((outcome) =>
    outcome.in === 'forge' ? [{ ref: outcome.ref, sha: outcome.sha }] : [],
  )
}

/** Prepare one durable replay. HEAD is detached; the published branch remains
 * untouched until the explicit compare-and-swap. */
export async function prepareRestack(
  deps: RestackDeps,
  input: {
    attempt: number
    branch: string
    oldBase: string
    targetBase: string
    id: string
    oldHead?: string
    restackId?: string
  },
): Promise<ReconcileTransaction> {
  if (await deferMixedVersion(deps.store, deps.slug, KERNEL)) throw new MixedVersionDeferral()
  const capability = requireRewrite(deps.forge)
  await recoverLostCandidate(deps)
  const recovery = (await readBuildFacts(deps.store, deps.slug)).value.candidateRecoveries[
    deps.automatic ? 'restack' : 'reconcile'
  ]
  if (
    recovery &&
    (input.id === recovery.id ||
      (deps.automatic === undefined &&
        (await readBuildFacts(deps.store, deps.slug)).value.reconcileTransaction?.id ===
          recovery.id))
  )
    input = { ...input, id: recovery.replacementId }
  const events = await replayHistory(deps)
  const prior = events.findLast(
    (e) =>
      e.type === 'reconcile.prepared' &&
      (deps.automatic === undefined
        ? e.payload.attempt === input.attempt
        : e.payload.id === input.id),
  )
  if (prior?.type === 'reconcile.prepared' && input.oldHead === undefined) {
    if (prior.payload.targetBase !== input.targetBase)
      throw new Error('reconcile target changed within an occurrence')
    const contended = events.findLast(
      (e) => e.type === 'reconcile.contended' && e.payload.id === prior.payload.id,
    )
    if (contended?.type === 'reconcile.contended') {
      if (contended.payload.actual === null)
        throw new Error('build branch was deleted; restore its known history before retrying')
      return reprepareFromPublished(
        deps,
        input,
        prior.payload,
        events,
        deps.automatic === undefined ? input.id : `${input.id}-retry`,
        true,
      )
    }
    try {
      await continuePreparation(deps, prior.payload, events)
    } catch (error) {
      if (!(error instanceof RetainedHistoryUnavailable)) throw error
      // A candidate already requested for publication is retired by its caller.
      const request = (
        await readBuildFacts(deps.store, deps.slug)
      ).value.publication.latestUncompletedRequest()
      if (
        request !== undefined &&
        'rewrite' in request.payload &&
        request.payload.rewrite?.id === prior.payload.id
      )
        throw error
      // History the transaction needs is retained nowhere: redo the replay
      // from the published branch under a fresh id, so same-id replay and
      // intent facts never steer recovery back to the lost commit.
      return reprepareFromPublished(
        deps,
        input,
        prior.payload,
        events,
        `${prior.payload.id}-redo`,
        false,
      )
    }
    return prior.payload
  }
  const oldHead =
    input.oldHead ??
    (await capability.snapshot({
      workspacePath: deps.workspacePath,
      branch: input.branch,
      destinationRef: `refs/autobuild/reconcile/${deps.slug}/head`,
    }))
  const ancestor = await git(deps, ['merge-base', '--is-ancestor', input.oldBase, oldHead], true)
  if (ancestor.exitCode !== 0)
    throw new Error(
      `build head ${oldHead} has incompatible provenance with ${input.oldBase}; operator resolution required`,
    )
  const localBranchHead = await output(deps, [
    'rev-parse',
    '--verify',
    `refs/heads/${input.branch}`,
  ])
  const localIncluded =
    (await git(deps, ['merge-base', '--is-ancestor', localBranchHead, oldHead], true)).exitCode ===
    0
  const knownLocalHead = events.some(
    (event) =>
      (event.type === 'reconcile.prepared' &&
        (event.payload.oldHead === localBranchHead ||
          event.payload.localBranchHead === localBranchHead)) ||
      (event.type === 'reconcile.publish-intended' && event.payload.headSha === localBranchHead),
  )
  if (!localIncluded && !knownLocalHead)
    throw new Error(
      `local branch ${input.branch} has unknown work at ${localBranchHead}; preserve and reconcile it with the authoritative head before retrying`,
    )
  const automatic =
    input.restackId === undefined
      ? undefined
      : (await readBuildFacts(deps.store, deps.slug)).value.log.restack.active
  const frozenMessage =
    deps.automatic?.message ?? (automatic?.id === input.restackId ? automatic?.message : undefined)
  const description = await deps.store.getArtifact(deps.slug, 'pr-description')
  if (description === null && frozenMessage === undefined)
    throw new Error('reconcile requires the deposited PR description')
  const message =
    frozenMessage ??
    withBuildTrailer(new TextDecoder().decode(description!.content), deps.slug, {
      includesSubject: true,
    })
  const tree = await output(deps, ['rev-parse', `${oldHead}^{tree}`])
  const changeSha = (
    await commitGit(deps, oldHead, ['commit-tree', tree, '-p', input.oldBase, '-m', message])
  ).stdout.trim()
  // Persist exact bytes before the event: a released remote sandbox may be the
  // only Git database containing this temporary commit. Its tree and parent are
  // retained inputs, so restoring the commit object reconstructs the same SHA.
  await deps.store.putArtifact(deps.slug, {
    kind: `reconcile-change-${changeSha}`,
    content: (await git(deps, ['cat-file', 'commit', changeSha])).stdout,
  })
  // Protect the commit before naming it in durable state.
  await git(deps, ['update-ref', `refs/autobuild/reconcile/${deps.slug}/${input.id}`, changeSha])
  const transaction: ReconcileTransaction = {
    id: input.id,
    ...(input.restackId === undefined ? {} : { restackId: input.restackId }),
    attempt: input.attempt,
    branch: input.branch,
    oldHead,
    oldBase: input.oldBase,
    targetBase: input.targetBase,
    changeSha,
    workspaceHead: await output(deps, ['rev-parse', 'HEAD']),
    localBranchHead,
  }
  await replayAppend(deps, {
    actor: KERNEL,
    type: 'reconcile.prepared',
    payload: transaction,
  })
  await continuePreparation(deps, transaction, events)
  return transaction
}
/** Replay again from a fresh snapshot of the published build branch. A
 * contended publication checks the observed head for divergence; a redo after
 * lost history relies on the ancestry check of the fresh preparation. */
async function reprepareFromPublished(
  deps: RestackDeps,
  input: Parameters<typeof prepareRestack>[1],
  prior: ReconcileTransaction,
  events: readonly AbEvent[],
  id: string,
  contended: boolean,
): Promise<ReconcileTransaction> {
  // An earlier redo already prepared this id: continue it, never write another.
  if (
    !contended &&
    deps.automatic !== undefined &&
    events.some((e) => e.type === 'reconcile.prepared' && e.payload.id === id)
  )
    return prepareRestack(deps, { ...input, id })
  const observed = await requireRewrite(deps.forge).snapshot({
    workspacePath: deps.workspacePath,
    branch: input.branch,
    destinationRef: `refs/autobuild/reconcile/${deps.slug}/head`,
  })
  const intent = events.findLast(
    (e) => e.type === 'reconcile.publish-intended' && e.payload.id === prior.id,
  )
  const candidate =
    intent?.type === 'reconcile.publish-intended' ? intent.payload.headSha : undefined
  const basedOnCandidate =
    candidate !== undefined &&
    (observed === candidate ||
      (events.some(
        (e) =>
          e.type === 'reconcile.rewritten' &&
          e.payload.id === prior.id &&
          e.payload.headSha === candidate,
      ) &&
        (await git(deps, ['merge-base', '--is-ancestor', candidate, observed], true)).exitCode ===
          0))
  if (
    contended &&
    !basedOnCandidate &&
    (await git(deps, ['merge-base', '--is-ancestor', prior.oldHead, observed], true)).exitCode !== 0
  )
    throw new Error(`build branch diverged to ${observed}; operator provenance review required`)
  return prepareRestack(deps, {
    ...input,
    id,
    ...(prior.restackId === undefined ? {} : { restackId: prior.restackId }),
    oldHead: observed,
    oldBase: basedOnCandidate ? prior.targetBase : prior.oldBase,
  })
}

/** Redo an automatic restack whose retained history is lost, from the
 * published branch under a fresh transaction id. */
export async function redoRestack(
  deps: RestackDeps,
  transaction: EventPayload<'restack.prepared'>,
): Promise<ReconcileTransaction> {
  return reprepareFromPublished(
    deps,
    {
      attempt: 1,
      branch: transaction.branch,
      oldBase: transaction.oldBase,
      targetBase: transaction.targetBase,
      id: transaction.id,
    },
    { ...transaction, attempt: 1 },
    await replayHistory(deps),
    `${transaction.id}-redo`,
    false,
  )
}

async function continuePreparation(
  deps: RestackDeps,
  transaction: ReconcileTransaction,
  events: readonly AbEvent[],
) {
  const facts = (await readBuildFacts(deps.store, deps.slug)).value
  const ctx = retention(deps, facts, transaction, requireRewrite(deps.forge).archive)
  for (const sha of [
    transaction.oldHead,
    transaction.oldBase,
    transaction.targetBase,
    transaction.changeSha,
  ])
    await restoreOrRedo(ctx, sha)
  const replayed = events.findLast(
    (e) => e.type === 'reconcile.replayed' && e.payload.id === transaction.id,
  )
  if (replayed !== undefined) {
    const operation = await git(deps, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], true)
    const parent = await output(deps, ['show', '-s', '--format=%P', 'HEAD'])
    if (operation.exitCode === 0) {
      if (operation.stdout.trim() !== transaction.changeSha)
        throw new Error('another cherry-pick occupies the recovered reconcile workspace')
      return
    }
    const currentHead = await output(deps, ['rev-parse', 'HEAD'])
    const intent = events.findLast(
      (e) => e.type === 'reconcile.publish-intended' && e.payload.id === transaction.id,
    )
    if (intent?.type === 'reconcile.publish-intended') {
      if (currentHead === intent.payload.headSha && parent === transaction.targetBase) return
      if ((await output(deps, ['status', '--porcelain', '--untracked-files=no'])) !== '')
        throw new Error(
          'cannot restore an intended replay over local changes; preserve and inspect them',
        )
      const candidate = intent.payload.headSha
      await restoreOrRedo(ctx, candidate)
      await deps.beforeRewrite?.()
      await git(deps, ['checkout', '--detach', candidate])
      return
    }
    if (
      parent === transaction.targetBase &&
      currentHead !== transaction.workspaceHead &&
      buildTrailers(await output(deps, ['show', '-s', '--format=%B', 'HEAD'])).join() === deps.slug
    )
      return
    // A replacement workspace without a resolved intent replays the same durable
    // change; no resolver-authored result is discarded.
  }
  const workspace = events.findLast((e) => e.type === 'workspace.provisioned')
  // Remote execution has read-only Git credentials. Trusted publication retains
  // these tips after execution teardown, before replacing the branch.
  if (workspace?.type !== 'workspace.provisioned' || !isRemoteWorkspace(workspace.payload))
    await retainTips(deps, transaction, [
      transaction.oldHead,
      transaction.oldBase,
      transaction.targetBase,
      transaction.changeSha,
    ])
  const pick = await git(deps, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], true)
  let conflicted = false
  if (pick.exitCode === 0) {
    if (pick.stdout.trim() !== transaction.changeSha)
      throw new Error('another cherry-pick occupies the reconcile workspace')
    conflicted = (await output(deps, ['ls-files', '-u'])) !== ''
  } else {
    const head = await output(deps, ['rev-parse', 'HEAD'])
    const parent = await output(deps, ['show', '-s', '--format=%P', 'HEAD'])
    const message = await output(deps, ['show', '-s', '--format=%B', 'HEAD'])
    // A crash after cherry-pick success but before the replay fact retains its result.
    if (
      !(
        parent === transaction.targetBase &&
        buildTrailers(message).join() === deps.slug &&
        head !== transaction.workspaceHead
      )
    ) {
      if ((await output(deps, ['status', '--porcelain', '--untracked-files=no'])) !== '')
        throw new Error(
          'reconcile preparation requires a clean tracked worktree; preserve and inspect local work',
        )
      await deps.beforeRewrite?.()
      await git(deps, ['checkout', '--detach', transaction.targetBase])
      const result = await commitGit(
        deps,
        transaction.oldHead,
        ['cherry-pick', '--allow-empty', transaction.changeSha],
        true,
      )
      if (result.exitCode !== 0) {
        conflicted = (await output(deps, ['ls-files', '-u'])) !== ''
        if (!conflicted) {
          const pending = await git(deps, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], true)
          if (pending.exitCode !== 0 || pending.stdout.trim() !== transaction.changeSha)
            throw new Error(`single-change replay failed: ${result.stderr || result.stdout}`)
          // Redundant replay still represents this build as one empty commit.
          if ((await output(deps, ['diff', '--cached', '--name-only'])) !== '')
            throw new Error(`replay failed without an unmerged index: ${result.stderr}`)
          await commitGit(deps, transaction.oldHead, [
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--allow-empty',
            '--no-edit',
          ])
        }
      }
    }
  }
  await replayAppend(deps, {
    actor: KERNEL,
    type: 'reconcile.replayed',
    payload: {
      id: transaction.id,
      conflicted,
      ...(conflicted
        ? {
            files: (await git(deps, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout
              .split('\0')
              .filter(Boolean)
              .sort(),
          }
        : {}),
    },
  })
}

/** `git clean` pathspecs for every declared generated selector. */
export function generatedCleanPathspecs(declarations: readonly GeneratedEntry[]): string[] {
  return generatedSelectors(declarations).map((selector) => `:(glob)${selector}`)
}

/**
 * Decide and record a conflicted automatic replay's `[[generated]]`
 * regeneration: `skipped` when some conflicted path is undeclared, else run
 * the declared commands on the reproduced conflict. A resolved head is
 * retained before its fact is written, so a durable `resolved` always names
 * recoverable bytes. On failure the recorded conflict is re-established for
 * the agent reconcile that follows.
 */
export async function regenerateRestackConflict(
  deps: RestackDeps & { signal?: AbortSignal },
  transaction: EventPayload<'restack.prepared'>,
  files: readonly string[],
  declarations: readonly GeneratedEntry[],
): Promise<EventPayload<'restack.regenerated'>> {
  const { groups, other } = classifyGenerated(files, declarations)
  const record = async (payload: EventPayload<'restack.regenerated'>) => {
    await deps.store.append(deps.slug, { actor: KERNEL, type: 'restack.regenerated', payload })
    return payload
  }
  const commands = groups.map((group) => ({ command: group.command, files: group.files }))
  if (files.length === 0)
    throw new Error('a conflicted replay recorded no conflicted paths to regenerate')
  if (other.length > 0)
    return record({
      id: transaction.id,
      files: [...files],
      commands,
      outcome: 'skipped',
      reason: regenerationReason(`conflicts outside [[generated]]: ${other.join(', ')}`),
    })
  const sorted = [...files].sort()
  const restore = async () => {
    await git(deps, ['cherry-pick', '--abort'], true)
    await deps.beforeRewrite?.()
    await git(deps, ['reset', '-q', '--hard'])
    await git(deps, ['clean', '-q', '-fd', '--', ...generatedCleanPathspecs(declarations)])
    await git(deps, ['checkout', '-q', '--detach', transaction.targetBase])
    await commitGit(
      deps,
      transaction.oldHead,
      ['cherry-pick', '--allow-empty', transaction.changeSha],
      true,
    )
    const unmerged = (await git(deps, ['diff', '--name-only', '--diff-filter=U', '-z'])).stdout
      .split('\0')
      .filter(Boolean)
      .sort()
    if (unmerged.join('\0') !== sorted.join('\0'))
      throw new Error(
        `restack conflict did not reproduce: expected ${sorted.join(', ')}, found ${unmerged.join(', ') || 'none'}`,
      )
    if (
      (await output(deps, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'])) !== transaction.changeSha
    )
      throw new Error('another cherry-pick occupies the restack workspace')
  }
  await restore()
  const result = await regenerateConflict(
    {
      exec: deps.exec,
      workspacePath: deps.workspacePath,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    {
      files: sorted,
      groups,
      selectors: generatedSelectors(declarations),
      identitySource: transaction.oldHead,
    },
  )
  if (result.outcome === 'failed') {
    await restore()
    return record({ id: transaction.id, files: [...files], commands, ...result })
  }
  await retainReplay(deps, result.head, transaction.targetBase)
  return record({ id: transaction.id, files: [...files], commands, ...result })
}

/**
 * Adopt a durably resolved regeneration after a crash or a replacement
 * workspace: restore its retained head instead of running the commands or
 * an agent again.
 */
export async function adoptRegeneratedRestack(
  deps: RestackDeps,
  transaction: EventPayload<'restack.prepared'>,
  head: string,
): Promise<void> {
  if ((await output(deps, ['rev-parse', 'HEAD'])) !== head) {
    await git(deps, ['cherry-pick', '--abort'], true)
    await deps.beforeRewrite?.()
    await git(deps, ['reset', '-q', '--hard'])
    const facts = (await readBuildFacts(deps.store, deps.slug)).value
    await restoreOrRedo(
      retention(deps, facts, transaction, requireRewrite(deps.forge).archive),
      head,
    )
    await git(deps, ['checkout', '-q', '--detach', head])
  }
  if ((await output(deps, ['show', '-s', '--format=%P', head])) !== transaction.targetBase)
    throw new Error(`the regenerated replay ${head} is not based on ${transaction.targetBase}`)
  const trailers = buildTrailers(await output(deps, ['show', '-s', '--format=%B', head]))
  if (trailers.length !== 1 || trailers[0] !== deps.slug)
    throw new Error(`the regenerated replay ${head} lost its Autobuild-Build: ${deps.slug} trailer`)
}

export async function validateRestack(
  deps: RestackDeps,
  transaction: ReconcileTransaction,
  head: string,
) {
  for (const operation of ['CHERRY_PICK_HEAD', 'MERGE_HEAD', 'REBASE_HEAD']) {
    if ((await git(deps, ['rev-parse', '--verify', operation], true)).exitCode === 0)
      throw new Error(`finish ${operation} before completing reconcile`)
  }
  for (const directory of ['rebase-merge', 'rebase-apply', 'sequencer']) {
    const path = await output(deps, ['rev-parse', '--git-path', directory])
    if ((await deps.exec(['test', '-d', path], { cwd: deps.workspacePath })).exitCode === 0)
      throw new Error(`finish the Git ${directory} operation before completing reconcile`)
  }
  if ((await output(deps, ['status', '--porcelain', '--untracked-files=no'])) !== '')
    throw new Error('reconcile publication requires a clean worktree')
  if ((await output(deps, ['ls-files', '-u'])) !== '') throw new Error('unmerged files remain')
  const parents = await output(deps, ['show', '-s', '--format=%P', head])
  if (parents !== transaction.targetBase)
    throw new Error(
      `reconcile requires exactly one commit parent ${transaction.targetBase}; found ${parents}`,
    )
  const trailers = buildTrailers(await output(deps, ['show', '-s', '--format=%B', head]))
  if (trailers.length !== 1 || trailers[0] !== deps.slug)
    throw new Error(`reconcile requires exactly one Autobuild-Build: ${deps.slug} trailer`)
  const violations = await reconcileScratchViolations(deps.exec, deps.workspacePath, head, [
    transaction.oldHead,
    transaction.targetBase,
  ])
  if (violations.length) throw phaseScratchRejection(violations)
}

/** Intent is durable before the CAS. Record proven writes even when readback
 * observes a later writer, but complete only while the candidate is current. */
export async function publishRestack(
  deps: RestackDeps,
  intent: EventPayload<'reconcile.publish-intended'>,
) {
  const capability = requireRewrite(deps.forge)
  const events = await replayHistory(deps)
  const start = events.findLast(
    (e) => e.type === 'reconcile.started' && e.payload.attempt === intent.attempt,
  )
  if (
    deps.automatic === undefined &&
    (start?.type !== 'reconcile.started' || start.payload.baseSha !== intent.targetBase)
  )
    throw new Error('rewrite target does not equal the authoritative reconcile start')
  await validateRestack(deps, intent, intent.headSha)
  const files = (await git(deps, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout
    .split('\0')
    .filter((path) => path !== '')
    .sort()
  if (files.length > 0) {
    const operation = deps.automatic === undefined ? 'reconcile' : 'restack'
    const pathsHash = createHash('sha256').update(JSON.stringify(files)).digest('hex')
    const id = `${operation}:${intent.id}:${intent.headSha}:untracked:${pathsHash}`
    const { observations } = (await readBuildFacts(deps.store, deps.slug)).value
    if (
      !observations.some(
        (entry) => entry.id === id && JSON.stringify(entry.files) === JSON.stringify(files),
      )
    ) {
      await deps.store.append(deps.slug, {
        actor: KERNEL,
        type: 'observation.recorded',
        payload: {
          id,
          kind: 'followup',
          summary: `Restack/reconcile publication excludes untracked files: ${files.map((path) => JSON.stringify(path)).join(', ')}`,
          files,
          refs: [`${operation}:${intent.id}`, intent.headSha],
        },
      })
    }
  }
  const archives = await retainTips(deps, intent, [intent.headSha])
  await deps.beforeRewrite?.()
  await suspendNativeLanding(deps, intent.id)
  const result = await capability.replace({
    workspacePath: deps.workspacePath,
    branch: intent.branch,
    expected: intent.oldHead,
    localExpected: intent.localBranchHead,
    sha: intent.headSha,
  })
  if (
    (result.kind === 'published' || result.rewritten === true) &&
    !events.some((e) => e.type === 'reconcile.rewritten' && e.payload.id === intent.id)
  ) {
    const { artifact: _, ...rewrite } = intent
    await replayAppend(deps, {
      actor: KERNEL,
      type: 'reconcile.rewritten',
      payload: {
        ...rewrite,
        archives,
        ...(result.kind === 'lease-mismatch' ? { observedHead: result.actual } : {}),
      },
    })
  }
  return result
}
