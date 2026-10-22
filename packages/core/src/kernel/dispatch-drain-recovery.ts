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
  recoveryRun?: string,
): Promise<boolean> {
  const upgrades = (await readDispatchUpgrade(store, repo)).value
  let state = upgrades.runs[predecessor]
  if (!state?.request || !state.handoff || state.completed) return true
  if (!state.released) return false
  // A validated launcher recovery acquires a fresh run identity. Keep the
  // original successor in retirement facts while fencing writes by the actual
  // current holder in the same launcher lineage.
  if (recoveryRun && upgrades.lineages[recoveryRun] !== state.handoff.payload.lineage) return false
  const lease = (await store.getRepo(repo))?.lease
  if (
    lease?.holder !== (recoveryRun ?? state.request.payload.successor) ||
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
