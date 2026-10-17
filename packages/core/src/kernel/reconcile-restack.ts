import { readBuildFacts } from '../store/reduced-reads'
import { isRemoteWorkspace } from '../events/workspace-remote'
import type { AbEvent } from '../events/catalog'
import type { EventPayload } from '../events/payloads'
import { KERNEL } from '../events/envelope'
import type { BuildStore } from '../store/types'
import type { Forge } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { buildTrailers, withBuildTrailer } from './build-identity'
import { reconcileScratchViolations, phaseScratchRejection } from '../ports/workspace/phase-scratch'

export type ReconcileTransaction = EventPayload<'reconcile.prepared'>
export interface RestackDeps {
  store: BuildStore
  slug: string
  workspacePath: string
  forge: Forge
  exec: Exec
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
export function requireRewrite(forge: Forge) {
  if (forge.rewrite === undefined)
    throw new Error(
      `${forge.name} lacks the reconcile rewrite capability; upgrade the forge plugin to support authoritative snapshots, immutable refs/autobuild/archive/ refs and expected-head guarded replacement`,
    )
  return forge.rewrite
}

export async function archiveTips(deps: RestackDeps, extra: string[] = []) {
  const capability = requireRewrite(deps.forge)
  const facts = (await readBuildFacts(deps.store, deps.slug)).value
  const tips = new Set([...facts.gitTips, ...extra])
  const archives: { ref: string; sha: string }[] = []
  for (const sha of tips) {
    const ref = `refs/autobuild/archive/${deps.slug}/${sha}`
    // Recovery can obtain evidence from an already published exact archive.
    if ((await git(deps, ['cat-file', '-e', `${sha}^{commit}`], true)).exitCode !== 0) {
      if (deps.forge.name === 'local-git')
        throw new Error(`missing recorded Git object ${sha}; restore it before reconcile`)
      await git(deps, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin', ref])
    }
    await capability.archive({ workspacePath: deps.workspacePath, ref, sha })
    archives.push({ ref, sha })
  }
  return archives
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
  },
): Promise<ReconcileTransaction> {
  const capability = requireRewrite(deps.forge)
  const events = (await readBuildFacts(deps.store, deps.slug)).value.reconcileHistory
  const prior = events.findLast(
    (e) => e.type === 'reconcile.prepared' && e.payload.attempt === input.attempt,
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
      const observed = await capability.snapshot({
        workspacePath: deps.workspacePath,
        branch: input.branch,
        destinationRef: `refs/autobuild/reconcile/${deps.slug}/head`,
      })
      const intent = events.findLast(
        (e) => e.type === 'reconcile.publish-intended' && e.payload.id === prior.payload.id,
      )
      const candidate =
        intent?.type === 'reconcile.publish-intended' ? intent.payload.headSha : undefined
      const basedOnCandidate =
        candidate !== undefined &&
        (await git(deps, ['merge-base', '--is-ancestor', candidate, observed], true)).exitCode === 0
      if (
        !basedOnCandidate &&
        (await git(deps, ['merge-base', '--is-ancestor', prior.payload.oldHead, observed], true))
          .exitCode !== 0
      )
        throw new Error(`build branch diverged to ${observed}; operator provenance review required`)
      return prepareRestack(deps, {
        ...input,
        oldHead: observed,
        oldBase: basedOnCandidate ? prior.payload.targetBase : prior.payload.oldBase,
      })
    }
    await continuePreparation(deps, prior.payload, events)
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
  const description = await deps.store.getArtifact(deps.slug, 'pr-description')
  if (description === null) throw new Error('reconcile requires the deposited PR description')
  const message = withBuildTrailer(new TextDecoder().decode(description.content), deps.slug, {
    includesSubject: true,
  })
  const tree = await output(deps, ['rev-parse', `${oldHead}^{tree}`])
  const changeSha = await output(deps, ['commit-tree', tree, '-p', input.oldBase, '-m', message])
  // Protect the commit before naming it in durable state.
  await git(deps, ['update-ref', `refs/autobuild/reconcile/${deps.slug}/${input.id}`, changeSha])
  const transaction: ReconcileTransaction = {
    id: input.id,
    attempt: input.attempt,
    branch: input.branch,
    oldHead,
    oldBase: input.oldBase,
    targetBase: input.targetBase,
    changeSha,
    workspaceHead: await output(deps, ['rev-parse', 'HEAD']),
    localBranchHead,
  }
  await deps.store.append(deps.slug, {
    actor: KERNEL,
    type: 'reconcile.prepared',
    payload: transaction,
  })
  await continuePreparation(deps, transaction, events)
  return transaction
}
async function continuePreparation(
  deps: RestackDeps,
  transaction: ReconcileTransaction,
  events: readonly AbEvent[],
) {
  for (const sha of [
    transaction.oldHead,
    transaction.oldBase,
    transaction.targetBase,
    transaction.changeSha,
  ]) {
    if ((await git(deps, ['cat-file', '-e', `${sha}^{commit}`], true)).exitCode !== 0) {
      if (deps.forge.name === 'local-git')
        throw new Error(
          `missing retained replay object ${sha}; restore the Git database before retrying`,
        )
      await git(deps, [
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        `refs/autobuild/archive/${deps.slug}/${sha}`,
      ])
    }
  }
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
    if (parent === transaction.targetBase) return
    const intent = events.findLast(
      (e) => e.type === 'reconcile.publish-intended' && e.payload.id === transaction.id,
    )
    if (intent?.type === 'reconcile.publish-intended') {
      if ((await output(deps, ['status', '--porcelain', '--untracked-files=no'])) !== '')
        throw new Error(
          'cannot restore an intended replay over local changes; preserve and inspect them',
        )
      const candidate = intent.payload.headSha
      if ((await git(deps, ['cat-file', '-e', `${candidate}^{commit}`], true)).exitCode !== 0)
        await git(deps, [
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          'origin',
          `refs/autobuild/archive/${deps.slug}/${candidate}`,
        ])
      await git(deps, ['checkout', '--detach', candidate])
      return
    }
    // A replacement workspace without a resolved intent replays the same durable
    // change; no resolver-authored result is discarded.
  }
  const workspace = events.findLast((e) => e.type === 'workspace.provisioned')
  // Remote execution has read-only Git credentials. Trusted publication archives
  // these tips after execution teardown, before replacing the branch.
  if (workspace?.type !== 'workspace.provisioned' || !isRemoteWorkspace(workspace.payload))
    await archiveTips(deps, [
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
      await git(deps, ['checkout', '--detach', transaction.targetBase])
      const result = await git(deps, ['cherry-pick', '--allow-empty', transaction.changeSha], true)
      if (result.exitCode !== 0) {
        conflicted = (await output(deps, ['ls-files', '-u'])) !== ''
        if (!conflicted) {
          const pending = await git(deps, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], true)
          if (pending.exitCode !== 0 || pending.stdout.trim() !== transaction.changeSha)
            throw new Error(`single-change replay failed: ${result.stderr || result.stdout}`)
          // Redundant replay still represents this build as one empty commit.
          if ((await output(deps, ['diff', '--cached', '--name-only'])) !== '')
            throw new Error(`replay failed without an unmerged index: ${result.stderr}`)
          await git(deps, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--no-edit'])
        }
      }
    }
  }
  await deps.store.append(deps.slug, {
    actor: KERNEL,
    type: 'reconcile.replayed',
    payload: { id: transaction.id, conflicted },
  })
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
  if ((await output(deps, ['status', '--porcelain'])) !== '')
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

/** Intent is durable before the CAS. A receipt is appended only after exact
 * readback; callers complete only after this receipt. */
export async function publishRestack(
  deps: RestackDeps,
  intent: EventPayload<'reconcile.publish-intended'>,
) {
  const capability = requireRewrite(deps.forge)
  const events = (await readBuildFacts(deps.store, deps.slug)).value.reconcileHistory
  const start = events.findLast(
    (e) => e.type === 'reconcile.started' && e.payload.attempt === intent.attempt,
  )
  if (start?.type !== 'reconcile.started' || start.payload.baseSha !== intent.targetBase)
    throw new Error('rewrite target does not equal the authoritative reconcile start')
  await validateRestack(deps, intent, intent.headSha)
  const archives = await archiveTips(deps, [intent.headSha])
  const result = await capability.replace({
    workspacePath: deps.workspacePath,
    branch: intent.branch,
    expected: intent.oldHead,
    localExpected: intent.localBranchHead,
    sha: intent.headSha,
  })
  if (result.kind === 'lease-mismatch') return result
  if (!events.some((e) => e.type === 'reconcile.rewritten' && e.payload.id === intent.id)) {
    const { artifact: _, ...rewrite } = intent
    await deps.store.append(deps.slug, {
      actor: KERNEL,
      type: 'reconcile.rewritten',
      payload: { ...rewrite, archives },
    })
  }
  return result
}
