import type { TicketSource } from '../ports/types'
import type { BuildStore } from '../store/types'
import { readBuildFacts } from '../store/reduced-reads'
import { DISPATCHER } from '../events/envelope'
import type { EventPayload } from '../events/payloads'

/** A failed or partial enumeration cannot authorize verification or publication. */
export async function observeIntegration(
  store: BuildStore,
  tickets: TicketSource,
  slug: string,
): Promise<EventPayload<'integration.observed'>> {
  const record = await store.getBuild(slug)
  const state = (await readBuildFacts(store, slug)).value.state
  const observation: EventPayload<'integration.observed'> = {
    openChildren: [],
    diagnostics: [],
    contributions: [...(state.integration?.observation?.contributions ?? [])],
  }
  const children = new Set<string>()
  try {
    if (!record?.ticket || !tickets.integrationTree || !tickets.listAll)
      throw new Error('ticket source cannot establish exhaustive integration completeness')
    if (record.ticket.source !== tickets.name)
      throw new Error('configured ticket source differs from the frozen node source')
    const listing = await tickets.listAll()
    observation.diagnostics.push(...listing.diagnostics)
    for (const ticket of listing.tickets)
      if (ticket.target === record.ticket.id && !ticket.resolved) children.add(ticket.ref.id)
    // Frozen claims survive edits to the source ticket's target.
    for (const build of await store.listBuildsForRepo(record!.repo)) {
      const child = (await readBuildFacts(store, build.slug)).value.state
      if (child.target?.build === slug && child.status !== 'done' && child.status !== 'aborted')
        children.add(build.ticket?.id ?? build.slug)
      if (child.target?.build === slug && child.prState === 'merged')
        observation.contributions.push(build.slug)
    }
    observation.contributions.push(...(state.nodeRestack?.inventory?.contributions ?? []))
  } catch (error) {
    observation.diagnostics.push(error instanceof Error ? error.message : String(error))
  }
  observation.openChildren = [...children].sort()
  observation.diagnostics.sort()
  observation.contributions = [...new Set(observation.contributions)].sort()
  if (JSON.stringify(observation) !== JSON.stringify(state.integration?.observation))
    await store.append(slug, {
      actor: DISPATCHER,
      type: 'integration.observed',
      payload: observation,
    })
  return observation
}
