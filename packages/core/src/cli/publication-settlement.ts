import { publicationRetryGate, retryPublicationEffect } from '../kernel/publication-retry'
import { ForgeRequestDeferred } from '../ports/forge-request-context'
import { stat } from 'node:fs/promises'
import { deferMixedVersion, MixedVersionDeferral } from '../kernel/mixed-version'
import { suspendNativeLanding } from '../kernel/landing-publication'
import { completeAutomaticReconcile } from '../kernel/leaf-restack-completion'
import { readBuildFacts, readPhaseFailures } from '../store/reduced-reads'
import type { IdSource } from '../ids'
import { DISPATCHER, KERNEL } from '../events/envelope'
import type { Forge, WorkspacePublication } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { systemClock, type BuildStore, type Clock } from '../store/types'
import { completeFinalizePr } from './terminals'

export interface PublicationSettlementDeps {
  store: BuildStore
  storeRef: string
  publication?: WorkspacePublication
  forge: Forge
  workspacePath: string
  exec: Exec
  ids: IdSource
  runId: string
  /** Time source for the durable lease-liveness guard; defaults to the
   * system clock. The same injected clock the dispatcher uses for lease
   * liveness. */
  clock?: Clock
}

/** Hosted guests have a separate ref database. Refresh a real dispatcher cache
 * too, when this deployment retains one; origin-only dispatchers have none. */
async function confirmDispatcherCache(
  deps: PublicationSettlementDeps,
  branch: string,
  sha: string,
) {
  if (!deps.forge.confirmPublication) return
  try {
    if (!(await stat(deps.workspacePath)).isDirectory()) return
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return
    throw error
  }
  const repository = await deps.exec(['git', 'rev-parse', '--git-dir'], { cwd: deps.workspacePath })
  if (repository.exitCode !== 0 || !repository.stdout.trim()) return
  if (!(await deps.forge.confirmPublication(deps.workspacePath, branch, sha)))
    throw new Error(`dispatcher publication readback did not confirm ${sha}`)
}

/** Settle one durable request after the caller has observed environment
 * completion and released its exact execution lease. External effects precede
 * completion facts, making every crash gap safely retryable.
 *
 * Durable guard: before the publish path, the guest execution must be provably
 * over — either the log has no open execution, or the build's lease is
 * absent/expired. Publication is never attempted against a live guest and is
 * never performed twice for one request; no in-memory set is the sole guard. */
export async function settlePendingPublication(
  deps: PublicationSettlementDeps,
  slug: string,
): Promise<void> {
  const publication = deps.publication
  if (publication === undefined) return
  if (await deferMixedVersion(deps.store, slug)) return
  await completeAutomaticReconcile(deps.store, slug)
  let events = (await readBuildFacts(deps.store, slug)).value
  const request = events.publication.latestUncompletedRequest()
  if (request === undefined) return

  if (request.payload.operation === 'restack') {
    const record = await deps.store.getBuild(slug)
    const clock = deps.clock ?? systemClock
    if (
      events.state.sessions.open.length > 0 ||
      (events.open !== null &&
        record?.lease !== undefined &&
        new Date(record.lease.expiresAt).getTime() > clock().getTime())
    )
      return
    if (publication.rewrite === undefined)
      throw new Error('workspace provider lacks trusted restack publication')
    const ref = events.workspace?.ref
    if (ref === undefined) throw new Error('restack publication requires its retained workspace')
    const transaction = request.payload.rewrite
    const active = events.log.restack.active
    const intended = events.log.restack.intent
    if (
      transaction.headSha !== request.payload.sha ||
      active?.id !== transaction.id ||
      intended?.id !== transaction.id ||
      intended.headSha !== request.payload.sha ||
      intended.targetBase !== transaction.targetBase ||
      intended.oldHead !== transaction.oldHead ||
      intended.branch !== request.payload.branch
    )
      throw new Error('restack publication request does not match its durable intent')
    const retryDeps = { ...deps, slug, clock: deps.clock ?? systemClock, actor: DISPATCHER }
    await publicationRetryGate(retryDeps, 'restack', transaction.id)
    const archives = [...new Set([...events.gitTips, request.payload.sha])].map((sha) => ({
      ref: `refs/autobuild/archive/${slug}/${sha}`,
      sha,
    }))
    const external = <T>(effect: () => Promise<T>) =>
      retryPublicationEffect(
        retryDeps,
        'restack',
        transaction.id,
        events.state.reconcileAttempts + 1,
        effect,
      )
    await external(() => suspendNativeLanding({ ...deps, slug }, `publication:${request.seq}`))
    const result = await external(() =>
      publication.rewrite!({
        ref,
        sha: request.payload.sha,
        branch: transaction.branch,
        expected: transaction.oldHead,
        localExpected: transaction.localBranchHead,
        archives,
      }),
    )
    if (result.kind === 'published')
      await external(() =>
        confirmDispatcherCache(deps, request.payload.branch, request.payload.sha),
      )
    const latest = (await readBuildFacts(deps.store, slug)).value
    if (
      (result.kind === 'published' || result.rewritten === true) &&
      !latest.restackHistory.some(
        (e) => e.type === 'restack.rewritten' && e.payload.id === transaction.id,
      )
    )
      await deps.store.append(slug, {
        actor: DISPATCHER,
        type: 'restack.rewritten',
        payload: {
          ...transaction,
          archives,
          ...(result.kind === 'lease-mismatch' ? { observedHead: result.actual } : {}),
        },
      })
    if (result.kind === 'lease-mismatch') {
      await deps.store.append(slug, {
        actor: DISPATCHER,
        type: 'restack.contended',
        payload: { id: transaction.id, request: request.seq, actual: result.actual },
      })
      return
    }
    const settled = await readBuildFacts(deps.store, slug)
    if (!settled.value.publication.requestCompleted(request))
      await deps.store.appendIfCurrent(slug, settled.cursor, {
        actor: DISPATCHER,
        type: 'restack.completed',
        payload: transaction,
      })
    return
  }

  if (request.payload.operation === 'reconcile' && request.payload.rewrite !== undefined) {
    const record = await deps.store.getBuild(slug)
    const clock = deps.clock ?? systemClock
    if (
      events.open !== null &&
      record?.lease !== undefined &&
      new Date(record.lease.expiresAt).getTime() > clock().getTime()
    )
      return
    if (publication.rewrite === undefined)
      throw new Error(
        'workspace provider lacks trusted reconcile rewrite/archive publication; upgrade the provider before retrying',
      )
    const ref = events.workspace?.ref
    if (ref === undefined) throw new Error('reconcile publication requires its retained workspace')
    const transaction = request.payload.rewrite
    const intended = events.reconcileHistory.findLast(
      (event) => event.type === 'reconcile.publish-intended' && event.payload.id === transaction.id,
    )
    if (
      intended?.type !== 'reconcile.publish-intended' ||
      intended.payload.headSha !== request.payload.sha ||
      intended.payload.oldHead !== transaction.oldHead ||
      intended.payload.targetBase !== transaction.targetBase
    )
      throw new Error('reconcile request does not match its durable resolved intent')
    if (events.reconcileBases[String(transaction.attempt)] !== transaction.targetBase)
      throw new Error('reconcile publication target differs from the recorded start')
    const retryDeps = { ...deps, slug, clock: deps.clock ?? systemClock, actor: DISPATCHER }
    await publicationRetryGate(retryDeps, 'reconcile', transaction.id)
    const tips = new Set([...events.gitTips, request.payload.sha])
    const archives = [...tips].map((sha) => ({ ref: `refs/autobuild/archive/${slug}/${sha}`, sha }))
    const external = <T>(effect: () => Promise<T>) =>
      retryPublicationEffect(retryDeps, 'reconcile', transaction.id, transaction.attempt, effect)
    await external(() => suspendNativeLanding({ ...deps, slug }, `publication:${request.seq}`))
    const result = await external(() =>
      publication.rewrite!({
        ref,
        sha: request.payload.sha,
        branch: request.payload.branch,
        expected: transaction.oldHead,
        localExpected: transaction.localBranchHead,
        archives,
      }),
    )
    if (result.kind === 'published')
      await external(() =>
        confirmDispatcherCache(deps, request.payload.branch, request.payload.sha),
      )
    const history = (await readBuildFacts(deps.store, slug)).value.reconcileHistory
    if (
      (result.kind === 'published' || result.rewritten === true) &&
      !history.some((e) => e.type === 'reconcile.rewritten' && e.payload.id === transaction.id)
    )
      await deps.store.append(slug, {
        actor: DISPATCHER,
        type: 'reconcile.rewritten',
        payload: {
          ...transaction,
          headSha: request.payload.sha,
          archives,
          ...(result.kind === 'lease-mismatch' ? { observedHead: result.actual } : {}),
        },
      })
    if (result.kind === 'lease-mismatch') {
      await deps.store.append(slug, {
        actor: DISPATCHER,
        type: 'reconcile.contended',
        payload: { id: transaction.id, request: request.seq, actual: result.actual },
      })
      const failures = await readPhaseFailures(deps.store, slug, 'reconcile', transaction.attempt)
      await deps.store.append(slug, {
        actor: KERNEL,
        type: 'phase.failed',
        payload: {
          phase: 'reconcile',
          round: transaction.attempt,
          attempt: failures.count + 1,
          willRetry: true,
          error: `reconcile publication lost its expected-head lease to ${result.actual ?? '(deleted)'}; replay again onto frozen base ${transaction.targetBase}`,
        },
      })
      return
    }
    if (!(await readBuildFacts(deps.store, slug)).value.publication.requestCompleted(request))
      await deps.store.append(slug, {
        actor: DISPATCHER,
        type: 'reconcile.completed',
        payload: {
          headSha: request.payload.sha,
          rewriteId: transaction.id,
          artifact: request.payload.artifact,
        },
      })
    await completeAutomaticReconcile(deps.store, slug)
    return
  }

  const abandoned = events.publication.requestSettled(request)
  // Consulted for every uncompleted request, not only abandoned ones: a guest
  // that pushed its branch before dying is owed its completion fact, not a
  // re-push or a loss record.
  if (!publication.isPublished)
    throw new Error(
      'workspace provider lacks authoritative publication inspection; upgrade the provider',
    )
  const probe = () =>
    publication.isPublished!({
      ref: events.workspace?.ref,
      sha: request.payload.sha,
      branch: request.payload.branch,
    })
  const alreadyPublished = await probe()
  if (abandoned && !alreadyPublished) {
    // Last-chance backstop (AUT-328): the workspace is gone with this request
    // uncompleted. Record the loss durably (deduped per request) instead of
    // returning silently — the exact drop that lost the validate-hosted-
    // dispatcher generation-1 work. The finalize-step publish-failure path
    // below is unchanged: it already settles loudly via its failed outcome.
    if (!events.publication.lostRecorded(request)) {
      await deps.store.append(slug, {
        actor: DISPATCHER,
        type: 'publication.lost',
        payload: {
          request: request.seq,
          operation: request.payload.operation,
          branch: request.payload.branch,
          sha: request.payload.sha,
          reason: 'workspace released with the publication uncompleted',
        },
      })
    }
    return
  }

  try {
    if (!alreadyPublished) {
      // Never publish against a live guest: require durable proof the guest
      // execution ended (a recorded end or an expired/absent lease). The
      // adapter's process-local active/uncertain sets remain a second belt.
      const record = await deps.store.getBuild(slug)
      const clock = deps.clock ?? systemClock
      const leaseLive =
        record?.lease !== undefined &&
        new Date(record.lease.expiresAt).getTime() > clock().getTime()
      if (events.open !== null && leaseLive) return
      const ref = events.workspace?.ref
      if (ref === undefined)
        throw new Error(`build ${slug} has a publication request but no open workspace`)
      await suspendNativeLanding({ ...deps, slug }, `publication:${request.seq}`)
      try {
        await publication.publish({ ref, sha: request.payload.sha, branch: request.payload.branch })
      } catch (error) {
        if (!(await probe())) throw error
      }
      if (!(await probe()))
        throw new Error(`publication readback did not confirm ${request.payload.sha}`)
    }
  } catch (error) {
    if (error instanceof ForgeRequestDeferred) throw error
    if (error instanceof MixedVersionDeferral) return
    if (request.payload.operation !== 'finalize-step') throw error
    const detail = error instanceof Error ? error.message : String(error)
    const note = `finalize publication failed: ${detail}`
    await deps.store.append(slug, {
      actor: KERNEL,
      type: 'finalize.step-completed',
      payload: { step: request.payload.step, ok: false, note },
    })
    await deps.store.append(slug, {
      actor: KERNEL,
      type: 'observation.recorded',
      payload: {
        id: deps.ids('o'),
        kind: 'followup',
        summary: `finalize step "${request.payload.step}" failed — needs manual follow-up: ${note}`,
      },
    })
    return
  }
  await confirmDispatcherCache(deps, request.payload.branch, request.payload.sha)
  events = (await readBuildFacts(deps.store, slug)).value
  if (events.publication.requestCompleted(request)) return

  if (request.payload.operation === 'implement') {
    await deps.store.append(slug, {
      actor: DISPATCHER,
      type: 'implement.completed',
      payload: {
        round: request.payload.round,
        commits: { base: request.payload.base, head: request.payload.sha },
        artifact: request.payload.artifact,
      },
    })
    return
  }
  if (request.payload.operation === 'reconcile') {
    await deps.store.append(slug, {
      actor: DISPATCHER,
      type: 'reconcile.completed',
      payload: { mergeCommit: request.payload.sha, artifact: request.payload.artifact },
    })
    return
  }
  if (request.payload.operation === 'finalize-step') {
    await deps.store.append(slug, {
      actor: KERNEL,
      type: 'finalize.step-completed',
      payload: { step: request.payload.step, ok: true, headSha: request.payload.sha },
    })
    return
  }

  const description = await deps.store.getArtifact(
    slug,
    request.payload.description.kind,
    request.payload.description.rev,
  )
  if (description === null) throw new Error(`missing PR description for ${slug}`)
  const text = new TextDecoder().decode(description.content)
  const newline = text.indexOf('\n')
  const title = (newline === -1 ? text : text.slice(0, newline)).replace(/^#+\s*/, '').trim()
  if (title === '') throw new Error(`empty PR title for ${slug}`)
  const created = events.lastCreated
  if (created?.type !== 'build.created') throw new Error(`missing build.created for ${slug}`)

  await completeFinalizePr(
    {
      store: deps.store,
      env: {
        store: deps.storeRef,
        build: slug,
        phase: 'finalize',
        round: 1,
        session: `dispatcher-${deps.runId}`,
      },
      workspacePath: deps.workspacePath,
      forge: deps.forge,
      exec: deps.exec,
      ids: deps.ids,
    },
    events,
    {
      branch: request.payload.branch,
      baseBranch: events.state.baseBranch ?? created.payload.baseBranch,
      title,
      body: newline === -1 ? '' : text.slice(newline + 1).replace(/^\n+/, ''),
      mergeMessage: text,
      expectedHeadSha: request.payload.sha,
    },
  )
}
