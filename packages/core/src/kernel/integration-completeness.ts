import type { BuildState } from './reducer'
import type { TicketSource, TicketListing } from '../ports/types'
import type { BuildStore, BuildRecord } from '../store/types'
import { readBuildFacts } from '../store/reduced-reads'
import { DISPATCHER } from '../events/envelope'
import type { EventPayload } from '../events/payloads'

/** One exhaustive source sample shared by every node in a dispatcher pass.
 * Scheduling may be cached; publication always requests a sample from this pass. */
export interface IntegrationObservationInputs {
  listing: TicketListing
  builds: { record: BuildRecord; state: BuildState }[]
}
export async function integrationObservationInputs(
  store: BuildStore,
  tickets: TicketSource,
  repo: string,
): Promise<IntegrationObservationInputs> {
  if (!tickets.integrationTree || !tickets.listAll)
    throw new Error('ticket source cannot establish exhaustive integration completeness')
  const listing = await tickets.listAll()
  const builds = []
  for (const record of await store.listBuildsForRepo(repo))
    builds.push({ record, state: (await readBuildFacts(store, record.slug)).value.state })
  return { listing, builds }
}

/** A failed or partial enumeration cannot authorize verification or publication. */
export async function observeIntegration(
  store: BuildStore,
  tickets: TicketSource,
  slug: string,
  inputs?: () => Promise<IntegrationObservationInputs>,
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
    const { listing, builds } = await (inputs
      ? inputs()
      : integrationObservationInputs(store, tickets, record.repo))
    observation.diagnostics.push(...listing.diagnostics)
    for (const ticket of listing.tickets)
      if (ticket.target === record.ticket.id && !ticket.resolved) children.add(ticket.ref.id)
    // Frozen claims survive edits to the source ticket's target.
    for (const { record: build, state: child } of builds) {
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
