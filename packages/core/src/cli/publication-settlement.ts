import type { IdSource } from '../ids'
import { DISPATCHER, KERNEL } from '../events/envelope'
import type { Forge, WorkspacePublication } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { openExecution } from '../processes/execution-settlement'
import {
  publicationRequestCompleted,
  publicationRequestSettled,
} from '../processes/publication-state'
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
  let events = await deps.store.getEvents(slug)
  const request = events.findLast(
    (event) =>
      event.type === 'publication.requested' && !publicationRequestCompleted(events, event),
  )
  if (request?.type !== 'publication.requested') return

  const abandoned = publicationRequestSettled(events, request)
  const alreadyPublished =
    abandoned && publication.isPublished !== undefined
      ? await publication.isPublished({ sha: request.payload.sha, branch: request.payload.branch })
      : false
  if (abandoned && !alreadyPublished) return

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
      if (openExecution(events) !== null && leaseLive) return
      let ref: string | undefined
      for (const event of events) {
        if (event.type === 'workspace.provisioned') ref = event.payload.ref
        else if (event.type === 'workspace.released') ref = undefined
      }
      if (ref === undefined)
        throw new Error(`build ${slug} has a publication request but no open workspace`)
      await publication.publish({ ref, sha: request.payload.sha, branch: request.payload.branch })
    }
  } catch (error) {
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
  events = await deps.store.getEvents(slug)
  if (publicationRequestCompleted(events, request)) return

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
  const created = events.findLast((event) => event.type === 'build.created')
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
      baseBranch: created.payload.baseBranch,
      title,
      body: newline === -1 ? '' : text.slice(newline + 1).replace(/^\n+/, ''),
      mergeMessage: text,
      expectedHeadSha: request.payload.sha,
    },
  )
}
