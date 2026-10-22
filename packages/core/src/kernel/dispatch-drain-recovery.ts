import type { DispatchUpgradeState } from './dispatch-upgrade'
import { DISPATCHER } from '../events/envelope'
import type { BuildStore } from '../store/types'
import { readBuildFacts, readDispatchUpgrade } from '../store/reduced-reads'
/** A successor can finish retirement after predecessor death. Execution leases
 * still fence live runners; process liveness alone never proves work finished. */
export async function recoverDispatchDrain(
  store: BuildStore,
  repo: string,
  predecessor: string,
  now: Date,
): Promise<boolean> {
  let state = (await readDispatchUpgrade(store, repo)).value.runs[predecessor]
  if (!state?.request || !state.handoff || state.completed) return true
  if (!state.released) return false
  const lease = (await store.getRepo(repo))?.lease
  if (
    lease?.holder !== state.request.payload.successor ||
    Date.parse(lease.expiresAt) <= now.getTime()
  )
    return false
  const handoff = state.prepared!.payload
  for (const [slug, instance] of Object.entries(state.outstanding)) {
    const record = await store.getBuild(slug)
    if (record?.lease?.holder === instance && Date.parse(record.lease.expiresAt) > now.getTime())
      continue
    const execution = (await readBuildFacts(store, slug)).value.state.drainingExecutions?.[instance]
    const ended = execution?.ended
    const suspended = execution?.suspended
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'execution.drain-settled',
      payload: { correlation: handoff.correlation, instance },
    })
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.drain-settled',
      payload: {
        ...handoff,
        slug,
        instance,
        outcome: suspended ? 'suspended' : ended ? 'drained' : 'unknown',
      },
    })
  }
  state = (await readDispatchUpgrade(store, repo)).value.runs[predecessor]!
  if (Object.keys(state.outstanding).length) return false
  if (!state.completed)
    await store.appendRepo(repo, {
      actor: DISPATCHER,
      type: 'dispatcher.handoff-completed',
      payload: {
        ...handoff,
        successor: state.request!.payload.successor,
        mode: state.request!.payload.mode,
        startedAt: state.handoff!.payload.startedAt,
        endedAt: now.toISOString(),
        drained: state.drained,
        suspended: state.suspended,
      },
    })
  return true
}

/** Replay remote authorization independently of local retirement. Iterate newest
 * acceptances first so recovery can never roll an execution's target backward. */
export async function authorizeRemoteHandoffs(
  store: BuildStore,
  repo: string,
  upgrades?: DispatchUpgradeState,
): Promise<void> {
  const runs = Object.values((upgrades ?? (await readDispatchUpgrade(store, repo)).value).runs)
    .filter((run) => run.handoff)
    .sort((a, b) => b.handoff!.seq - a.handoff!.seq)
  const seen = new Set<string>()
  for (const run of runs) {
    const handoff = run.handoff!.payload
    for (const capture of handoff.remoteBuilds ?? []) {
      const key = JSON.stringify([capture.slug, capture.instance])
      if (seen.has(key)) continue
      seen.add(key)
      const facts = (await readBuildFacts(store, capture.slug)).value
      if (facts.open?.instance !== capture.instance) continue
      const runtime = facts.runnerAttaches.findLast((a) => a.instance === capture.instance)?.runtime
      if (!runtime) continue // A guest may attach after its predecessor retires.
      const authorization = facts.state.drainingExecutions?.[capture.instance]?.authorization
      if (authorization?.correlation === handoff.correlation) continue
      await store.appendIfCurrent(capture.slug, facts.state.lastSeq, {
        actor: DISPATCHER,
        type: 'execution.drain-authorized',
        payload: {
          correlation: handoff.correlation,
          run: handoff.run,
          runtime,
          targetRuntime: handoff.to,
          instance: capture.instance,
        },
      })
    }
  }
}
