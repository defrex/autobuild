import { readBuildFacts, type CurrentBuildFacts } from '../store/reduced-reads'
export { summaryBoundary, pendingSummaryRequests } from '../kernel/pr-summary'
import type { AbEvent } from '../events/catalog'
import { KERNEL } from '../events/envelope'
import { isRemoteWorkspace } from '../events/workspace-remote'
import { currentPrAttachments } from '../kernel/pr-attachments'
import type { Forge } from '../ports/types'
import { githubRateLimitUntil } from '../ports/forge/github-transport'
import { summaryMarker } from '../ports/forge/summary-marker'
import type { BuildStore, Clock } from '../store/types'
import { html, shellQuote, renderPrSummary } from './pr-summary'

export const SUMMARY_LIMIT = 65_536

interface SummaryDeps {
  store: BuildStore
  forge: Forge
  slug: string
  workspacePath: string
  storeRef: string
  clock: Clock
}

/** No credentials are accepted by the renderer. The full oversized projection
 * is deliberately not designated, avoiding recursive growth. */
export async function boundedSummary(
  deps: SummaryDeps,
  events: readonly AbEvent[] | CurrentBuildFacts,
): Promise<string> {
  const env = {
    build: deps.slug,
    store: deps.storeRef,
    phase: 'finalize' as const,
    round: 1,
    session: '',
  }
  const full = renderPrSummary(env, events)
  if (full.length <= SUMMARY_LIMIT) return full
  const meta = await deps.store.putArtifact(deps.slug, {
    kind: 'pr-summary',
    content: full,
    metadata: {},
  })
  const command = `ab artifact download ${shellQuote(deps.slug)} ${shellQuote(`pr-summary@${meta.revision}`)} --store ${shellQuote(deps.storeRef)} --output pr-summary.md`
  const compact = [
    summaryMarker(deps.slug),
    `## Autobuild: ${html(deps.slug)}`,
    '',
    `The full summary exceeds the comment limit. It includes ${(Array.isArray(events) ? currentPrAttachments(events) : (events as CurrentBuildFacts).designations).length} PR attachments.`,
    `Store: <code>${html(deps.storeRef)}</code>`,
    '',
    'Download the complete summary, including all pinned artifact commands and hosted links:',
    `<pre><code>${html(command)}</code></pre>`,
  ].join('\n')
  if (compact.length > SUMMARY_LIMIT) throw new Error('Summary locator exceeds comment limit')
  return compact
}

/** Caller owns the exclusive build lease and has fenced guest execution.
 * Claim-before-effect plus CAS also fences overlapping refresh triggers. */
export async function publishSummary(
  deps: SummaryDeps,
  boundary: { occurrence: number; boundary: number },
): Promise<'attempted' | 'skipped' | 'deferred'> {
  try {
    const events = (await readBuildFacts(deps.store, deps.slug)).value
    const pr = events.state.pr
    if (pr === undefined) return 'skipped'
    if (events.summaryAttempts.includes(boundary.occurrence)) return 'attempted'
    if (
      events.summaryEligibleAfter !== undefined &&
      Date.parse(events.summaryEligibleAfter) > deps.clock().getTime()
    )
      return 'deferred'
    const claim = await deps.store.appendIfCurrent(deps.slug, events.state.lastSeq, {
      actor: KERNEL,
      type: 'pr-summary.attempted',
      payload: { ...boundary, pr: pr.number },
    })
    if (claim === null) return 'skipped'
    let outcome: 'success' | 'failure' | 'rate-limited' = 'success'
    let eligibleAfter: string | undefined
    try {
      const body = await boundedSummary(deps, (await readBuildFacts(deps.store, deps.slug)).value)
      await deps.forge.commentOnPr(deps.workspacePath, pr.number, body)
    } catch (error) {
      eligibleAfter = githubRateLimitUntil(error, deps.clock().getTime())
      outcome = eligibleAfter === undefined ? 'failure' : 'rate-limited'
    }
    await deps.store.append(deps.slug, {
      actor: KERNEL,
      type: 'pr-summary.result',
      payload: {
        attempt: claim.seq,
        outcome,
        ...(eligibleAfter === undefined ? {} : { eligibleAfter }),
      },
    })
    return 'attempted'
  } catch {
    return 'skipped'
  }
}

/** Local boundary or durable guest handoff. Optional refresh failures never
 * prevent pipeline progress, including a failed request deposit. */
export async function refreshSummaryBoundary(deps: SummaryDeps): Promise<boolean> {
  try {
    const events = (await readBuildFacts(deps.store, deps.slug)).value
    const boundary = events.summaryBoundary
    if (boundary === undefined) return false
    const workspace = events.latestWorkspace
    if (workspace?.type === 'workspace.provisioned' && isRemoteWorkspace(workspace.payload)) {
      const request = events.summaryRequested[String(boundary.occurrence)]
      if (request !== undefined) {
        // A lost result/disposition append must not repeatedly park a guest.
        if (events.summaryAttempts.includes(boundary.occurrence)) return false
        if (
          events.summaryEligibleAfter !== undefined &&
          Date.parse(events.summaryEligibleAfter) > deps.clock().getTime()
        )
          return false
        return events.summaryRequests.some((event) => event.seq === request.seq)
      }
      if (events.state.pr === undefined && !events.finalizePublicationRequested) return false
      const written = await deps.store.appendIfCurrent(deps.slug, events.state.lastSeq, {
        actor: KERNEL,
        type: 'pr-summary.requested',
        payload: boundary,
      })
      return written !== null
    }
    await publishSummary(deps, boundary)
  } catch {
    /* Optional publication cannot fail phase execution. */
  }
  return false
}

/** Host-only, after execution settlement. Reuse a launch reservation only
 * before execution.start; otherwise acquire and release our own lease. */
export async function settleSummaryRequests(
  deps: SummaryDeps & { holder: string; reservation?: string },
): Promise<void> {
  let acquired = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  try {
    let events = (await readBuildFacts(deps.store, deps.slug)).value
    if (events.open !== null) return
    // Repair a crash after terminal/session completion but before guest handoff.
    const workspace = events.latestWorkspace
    if (workspace?.type !== 'workspace.provisioned' || !isRemoteWorkspace(workspace.payload)) return
    const holder = deps.reservation ?? deps.holder
    acquired = await deps.store.claimLease(deps.slug, holder, 60_000)
    if (!acquired) return
    heartbeat = setInterval(() => {
      void deps.store.heartbeat(deps.slug, holder).catch(() => {})
    }, 15_000)
    events = (await readBuildFacts(deps.store, deps.slug)).value
    if (events.open !== null) return
    await refreshSummaryBoundary(deps)
    events = (await readBuildFacts(deps.store, deps.slug)).value
    const requests = events.summaryRequests
    const latest = requests.at(-1)
    for (const request of requests) {
      if (request.type !== 'pr-summary.requested') continue
      const disposition =
        request === latest ? await publishSummary(deps, request.payload) : 'skipped'
      await deps.store.append(deps.slug, {
        actor: KERNEL,
        type: 'pr-summary.settled',
        payload: { request: request.seq, disposition },
      })
    }
  } catch {
    /* Best effort, separate from branch publication and phase outcome. */
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat)
    if (acquired && deps.reservation === undefined) {
      try {
        await deps.store.releaseLease(deps.slug, deps.holder)
      } catch {
        /* lease expires */
      }
    }
  }
}
